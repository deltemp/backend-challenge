import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { eventually } from "../support/eventually";
import { openWalletOverHttp } from "../support/http";
import { infra } from "../support/infra";
import { ledgerDiscrepancies } from "../support/ledger";
import { drained, messagesIn, sendMessage, wagerMessage } from "../support/messaging";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { balanceOf, transactionCommand } from "../support/use-cases";

const IMAGE = "wagering-app:test";
const PROJECT_ROOT = `${import.meta.dirname}/../..`;
// The network docker compose creates for the project named "wagering" in compose.yaml.
const NETWORK = "wagering_default";

interface Run {
  readonly code: number;
  readonly output: string;
}

/** Runs the docker CLI without a shell, so no argument is ever rewritten. */
async function docker(...args: string[]): Promise<Run> {
  const child = Bun.spawn(["docker", ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

async function dockerOrFail(...args: string[]): Promise<string> {
  const run = await docker(...args);
  if (run.code !== 0) {
    throw new Error(`docker ${args[0]} failed (${run.code}):\n${run.output.slice(-3000)}`);
  }
  return run.output;
}

/** The test database as seen from inside the compose network. */
function containerDatabaseUrl(database: TestDatabase): string {
  const url = new URL(database.url);
  url.hostname = "postgres";
  url.port = "5432";
  return url.toString();
}

// Windows cannot deliver a catchable SIGTERM to a process, so graceful shutdown (§10) is tested
// in a Linux container from the current sources, on the compose network.
describe("graceful shutdown of a consumer, in a container", () => {
  const sqs = createTestSqsClient();
  const container = `wagering-shutdown-${crypto.randomUUID().slice(0, 8)}`;
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let api: AppProcess | undefined;

  beforeAll(async () => {
    await dockerOrFail("build", "--tag", IMAGE, ".");
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    sql = new SQL(database.url);
    api = await startApp({ ...appEnvironment(database, queues), APP_ROLES: "api" });
    await api.waitUntilReady();
  }, 300_000);

  afterAll(() =>
    cleanUp(
      () => docker("rm", "--force", container),
      () => api?.stop(),
      () => sql?.close(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    if (sql !== undefined) {
      expect(await ledgerDiscrepancies(sql)).toEqual([]);
    }
  });

  test("on SIGTERM it finishes the message in flight, hands the others back at once, and exits", async () => {
    if (database === undefined || queues === undefined || sql === undefined || api === undefined) {
      throw new Error("setup did not complete");
    }
    const db = sql;
    const wallet = await openWalletOverHttp(api.baseUrl, "100.00");
    const commands = Array.from({ length: 3 }, () =>
      transactionCommand(wallet, { kind: "BET", money: { amount: "10.00", currency: "BRL" } }),
    );
    await dockerOrFail(
      "run",
      "--detach",
      "--init",
      "--name",
      container,
      "--network",
      NETWORK,
      ...[
        "NODE_ENV=test",
        "APP_ROLES=consumer",
        `DATABASE_URL=${containerDatabaseUrl(database)}`,
        "DATABASE_POOL_MAX=5",
        `AWS_REGION=${infra.awsRegion}`,
        "AWS_ENDPOINT_URL=http://localstack:4566",
        "AWS_ACCESS_KEY_ID=test",
        "AWS_SECRET_ACCESS_KEY=test",
        `SQS_WAGER_TRANSACTIONS_QUEUE=${queues.names.wagerTransactions}`,
        `SQS_WAGER_TRANSACTIONS_DLQ=${queues.names.wagerTransactionsDlq}`,
        `SQS_WAGER_EVENTS_QUEUE=${queues.names.wagerEvents}`,
        // Each message waits three seconds between its commit and its acknowledgement.
        "TEST_CONSUMER_ACK_DELAY_MS=3000",
      ].flatMap((variable) => ["--env", variable]),
      IMAGE,
    );
    for (const command of commands) {
      await sendMessage(sqs, queues.urls.wagerTransactions, wagerMessage(command), {
        groupId: wallet.id,
      });
    }
    await eventually("the first commit", async () => {
      const [row] = await db`
        select count(*)::int as bets from wager_transactions
        where wallet_id = ${wallet.id} and kind = 'BET'`;
      return row?.bets === 1 ? true : undefined;
    });

    // SIGTERM while the first message waits for its acknowledgement.
    await dockerOrFail("stop", "--time", "15", container);

    const exitCode = Number((await dockerOrFail("wait", container)).trim());
    const logs = await dockerOrFail("logs", container);
    // NestJS re-raises SIGTERM once its cleanup is done.
    expect(exitCode).toBe(143);
    expect(logs).toContain("sqs consumer stopped");
    expect(logs).toContain("application shut down");
    expect(logs).not.toContain("shutdown timed out");
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.urls.wagerTransactions,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    const [committed] = await db`
      select count(*)::int as bets from wager_transactions
      where wallet_id = ${wallet.id} and kind = 'BET'`;
    // Whatever was committed was acknowledged before the exit, and whatever was not is visible
    // again at once: nothing is left in flight, waiting for a visibility timeout.
    expect(Number(committed?.bets)).toBeGreaterThanOrEqual(1);
    expect(Attributes).toEqual({
      ApproximateNumberOfMessages: String(commands.length - Number(committed?.bets)),
      ApproximateNumberOfMessagesNotVisible: "0",
    });

    const rescuer = await startApp({ ...appEnvironment(database, queues), APP_ROLES: "consumer" });
    try {
      await drained(sqs, queues.urls.wagerTransactions);
    } finally {
      await rescuer.stop();
    }
    const [counts] = await sql`
      select
        (select count(*)::int from wager_transactions
          where wallet_id = ${wallet.id} and kind = 'BET') as bets,
        (select count(*)::int from inbox_messages) as inbox`;
    expect(counts).toEqual({ bets: 3, inbox: 3 });
    expect(await balanceOf(sql, wallet.id)).toBe("70.00");
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });
});
