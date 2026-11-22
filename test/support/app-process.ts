import { join } from "node:path";
import type { Subprocess } from "bun";
import type { TestDatabase } from "./databases";
import { infra } from "./infra";
import type { TestQueues } from "./queues";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const ENTRY_POINT = join(PROJECT_ROOT, "src", "main.ts");
const OUTPUT_TAIL_LINES = 40;

/** An application instance running as a real OS process, built from the current sources. */
export interface AppProcess {
  readonly pid: number;
  readonly baseUrl: string;
  /** The last lines the process wrote, to explain a failure. */
  outputTail(): string;
  /** Every line the process wrote so far, stdout and stderr interleaved. */
  output(): readonly string[];
  waitUntilReady(timeoutMs?: number): Promise<void>;
  /**
   * Sends a signal and resolves with the exit code. On Windows every signal terminates the
   * process at once: graceful shutdown on SIGTERM can only be observed on Linux and macOS.
   */
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<number>;
}

const running = new Set<Subprocess>();

// Every instance must be pointed at its test file's own resources, never at the shared ones
// that .env describes for `bun run dev`.
const REQUIRED_VARIABLES = [
  "DATABASE_URL",
  "SQS_WAGER_TRANSACTIONS_QUEUE",
  "SQS_WAGER_TRANSACTIONS_DLQ",
  "SQS_WAGER_EVENTS_QUEUE",
];
// Inherited variables an instance must never see: the LocalStack token is useless to it,
// MIKRO_ORM_* would override the validated configuration, and OTEL_* would make it export spans
// (and the SDK read its own settings) from whatever the developer's shell holds. A test that
// wants tracing passes the endpoint itself.
const WITHHELD_VARIABLES = [/^LOCALSTACK_/, /^MIKRO_ORM_/, /^OTEL_/];

function childEnvironment(environment: Record<string, string>): Record<string, string> {
  const missing = REQUIRED_VARIABLES.filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(`startApp needs ${missing.join(", ")}: build it with appEnvironment()`);
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !WITHHELD_VARIABLES.some((pattern) => pattern.test(entry[0])),
    ),
  );
  return {
    ...inherited,
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    PORT: "0",
    APP_ROLES: "api,consumer,outbox,retry",
    DATABASE_POOL_MAX: "5",
    ...environment,
  };
}

/** Environment that points an instance at one test file's database and queues. */
export function appEnvironment(database: TestDatabase, queues: TestQueues): Record<string, string> {
  return {
    DATABASE_URL: database.url,
    AWS_ENDPOINT_URL: infra.awsEndpointUrl,
    AWS_REGION: infra.awsRegion,
    SQS_WAGER_TRANSACTIONS_QUEUE: queues.names.wagerTransactions,
    SQS_WAGER_TRANSACTIONS_DLQ: queues.names.wagerTransactionsDlq,
    SQS_WAGER_EVENTS_QUEUE: queues.names.wagerEvents,
  };
}

/**
 * Starts `bun src/main.ts` on a free port and resolves once it is listening. Runs every role
 * unless `environment` sets APP_ROLES. A process that fails to start is killed.
 */
export async function startApp(
  environment: Record<string, string>,
  startupTimeoutMs = 20_000,
): Promise<AppProcess> {
  const lines: string[] = [];
  const outputTail = () => lines.slice(-OUTPUT_TAIL_LINES).join("\n");

  const child = Bun.spawn([process.execPath, ENTRY_POINT], {
    cwd: PROJECT_ROOT,
    env: childEnvironment(environment),
    stdout: "pipe",
    stderr: "pipe",
  });
  running.add(child);
  void child.exited.then(() => running.delete(child));

  let port: number;
  try {
    port = await listeningPortOf(child, lines, outputTail, startupTimeoutMs);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    pid: child.pid,
    baseUrl,
    outputTail,
    output: () => [...lines],
    waitUntilReady: (timeoutMs = 15_000) => waitUntilReady(baseUrl, timeoutMs, outputTail),
    stop: async (signal = "SIGTERM") => {
      if (child.exitCode === null) {
        child.kill(signal);
      }
      return child.exited;
    },
  };
}

function listeningPortOf(
  child: Subprocess<"ignore", "pipe", "pipe">,
  lines: string[],
  outputTail: () => string,
  startupTimeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`app did not start within ${startupTimeoutMs} ms:\n${outputTail()}`));
    }, startupTimeoutMs);
    void readLines(child.stdout, (line) => {
      lines.push(line);
      const listeningOn = listeningPort(line);
      if (listeningOn !== undefined) {
        clearTimeout(timer);
        resolve(listeningOn);
      }
    });
    void readLines(child.stderr, (line) => lines.push(line));
    void child.exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`app exited with code ${code} before listening:\n${outputTail()}`));
    });
  });
}

/** Safety net for the preload: no instance outlives the test run, even after a failure. */
export async function stopAllApps(): Promise<void> {
  const children = [...running];
  for (const child of children) {
    child.kill("SIGKILL");
  }
  await Promise.all(children.map((child) => child.exited));
}

async function waitUntilReady(
  baseUrl: string,
  timeoutMs: number,
  outputTail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastAnswer = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) {
        return;
      }
      lastAnswer = `HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastAnswer = String(error);
    }
    await Bun.sleep(200);
  }
  throw new Error(`app not ready within ${timeoutMs} ms (${lastAnswer}):\n${outputTail()}`);
}

function listeningPort(line: string): number | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    if (
      typeof entry === "object" &&
      entry !== null &&
      "msg" in entry &&
      entry.msg === "http server listening" &&
      "port" in entry &&
      typeof entry.port === "number"
    ) {
      return entry.port;
    }
  } catch {
    // Not a JSON log line.
  }
  return undefined;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      onLine(part.trimEnd());
    }
  }
  if (pending.length > 0) {
    onLine(pending);
  }
}
