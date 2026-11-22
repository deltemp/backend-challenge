// `bun run test:load`: the load test of the running compose stack (`docker compose up -d --build
// --wait` first). This script prepares the run, drives k6 (test/load/load.js) in its compose
// container, and judges the outcome:
//
//   1. checks the stack and records the environment (host, Docker, images, database size);
//   2. snapshots the counters of every replica (read inside each container: replicas publish no
//      port) and opens the wallets the run uses, over HTTP;
//   3. runs k6 while it samples, every second, the outbox gauges and the inbound queue's depth;
//   4. waits for the queue and the outbox to drain, reconciles every wallet over the API, reads
//      the counters again and each queue message's wait from the inbox;
//   5. compares k6's counts with the replicas' (each transaction processed exactly once) and
//      writes the report to test/load/results/.
//
// The exit code is 1 only when a correctness check fails: latency is measured, not judged.
// `--quick` runs a short version of every phase. Settings: see "LOAD_*" below and README.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type QueueAttributeName,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import { createSqsClient } from "../src/infrastructure/sqs/sqs-client";
import {
  type Check,
  type ClientCounts,
  correctnessChecks,
  counterDeltas,
  type DatabaseCounts,
  gaugeValue,
  type K6Summary,
  k6Value,
  type LoadPlan,
  type Outcomes,
  type Phase,
  parsePrometheus,
  phasesOf,
  type ResolvedUnknowns,
  renderReport,
  type Sample,
  type ServerCounts,
  type StateSample,
  sumOf,
} from "./load-report";

const ROOT = join(import.meta.dirname, "..");
const RESULTS = join(ROOT, "test", "load", "results");
const QUICK = process.argv.includes("--quick");
const BASE_URL = `http://localhost:${process.env.APP_PORT || "3000"}`;
const INBOUND_QUEUE = "wager-transactions.fifo";
const DEAD_LETTER_QUEUE = "wager-transactions-dlq.fifo";
const CONSUMER_NAME = "wager-transactions";
const PROVIDER_ID = "load-test";
const QUEUE_PROVIDER_ID = "load-test-queue";
const START_MARKER = "LOAD_TEST_STARTED";

interface Defaults {
  readonly steps: string;
  readonly stepSeconds: number;
  readonly warmupSeconds: number;
  readonly queueRate: number;
  readonly queueSeconds: number;
  readonly hotVus: number;
  readonly hotWallets: number;
  readonly hotSeconds: number;
  readonly wallets: number;
  readonly queueWallets: number;
  readonly drainTimeoutSeconds: number;
}

// Calibrated on the reference machine (docs/LOAD-TEST.md): the stack saturates between 100 and
// 200 rounds/s, so the steps cover both sides of that knee. The hot-wallet phase is short: its
// events drain one per round per wallet once it ends.
const FULL: Defaults = {
  steps: "25,50,100,150,200",
  stepSeconds: 30,
  warmupSeconds: 15,
  queueRate: 50,
  queueSeconds: 45,
  hotVus: 20,
  hotWallets: 2,
  hotSeconds: 15,
  wallets: 1000,
  queueWallets: 200,
  drainTimeoutSeconds: 900,
};

const SHORT: Defaults = {
  steps: "20,40",
  stepSeconds: 15,
  warmupSeconds: 5,
  queueRate: 20,
  queueSeconds: 15,
  hotVus: 10,
  hotWallets: 2,
  hotSeconds: 10,
  wallets: 200,
  queueWallets: 50,
  drainTimeoutSeconds: 300,
};

function log(message: string): void {
  console.log(`[load-test] ${message}`);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stepRates(fallback: string): number[] {
  const raw = process.env.LOAD_STEPS || fallback;
  const rates = raw.split(",").map((part) => Number(part.trim()));
  if (rates.some((rate) => !Number.isInteger(rate) || rate <= 0)) {
    throw new Error("LOAD_STEPS must list positive integers, such as 50,100,200");
  }
  if (new Set(rates).size !== rates.length) {
    throw new Error("LOAD_STEPS must not repeat a rate");
  }
  return rates;
}

async function run(command: readonly string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([...command], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with ${code}: ${stderr.trim()}`);
  }
  return { code, stdout };
}

/** Running containers of a compose service, by name. */
async function containersOf(service: string, profile?: string): Promise<string[]> {
  const profileArgs = profile === undefined ? [] : ["--profile", profile];
  const { stdout } = await run([
    "docker",
    "compose",
    ...profileArgs,
    "ps",
    "--format",
    "json",
    service,
  ]);
  const text = stdout.trim();
  if (text === "") {
    return [];
  }
  // Compose prints one JSON object per line (older versions: a single array).
  const entries: unknown[] = text.startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text.split("\n").map((line) => JSON.parse(line) as unknown);
  return entries
    .filter(
      (entry): entry is { Name: string; State: string } =>
        typeof entry === "object" &&
        entry !== null &&
        "Name" in entry &&
        "State" in entry &&
        entry.State === "running",
    )
    .map((entry) => entry.Name)
    .sort();
}

async function preflight(): Promise<string[]> {
  const ready = await fetch(`${BASE_URL}/health/ready`, { signal: AbortSignal.timeout(5000) })
    .then((response) => response.ok)
    .catch(() => false);
  if (!ready) {
    throw new Error(
      `the stack does not answer ready on ${BASE_URL}: start it with docker compose up -d --build --wait`,
    );
  }
  const replicas = await containersOf("app");
  if (replicas.length === 0) {
    throw new Error("no running app replica: start the stack with docker compose up -d --wait");
  }
  return replicas;
}

const METRICS_SCRIPT =
  'process.stdout.write(await (await fetch("http://127.0.0.1:3000/metrics")).text())';

/** Every replica's metrics, read inside its container. */
async function scrapeReplicas(replicas: readonly string[]): Promise<Map<string, Sample[]>> {
  const snapshots = await Promise.all(
    replicas.map(async (replica) => {
      const { stdout } = await run(["docker", "exec", replica, "bun", "-e", METRICS_SCRIPT]);
      return [replica, parsePrometheus(stdout)] as const;
    }),
  );
  return new Map(snapshots);
}

function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
}

async function describeEnvironment(
  replicas: readonly string[],
  sql: SQL,
): Promise<(readonly [string, string])[]> {
  const cpus = os.cpus();
  const info = JSON.parse((await run(["docker", "info", "--format", "{{json .}}"])).stdout) as {
    ServerVersion?: string;
    OperatingSystem?: string;
    NCPU?: number;
    MemTotal?: number;
  };
  const compose = await readFile(join(ROOT, "compose.yaml"), "utf8");
  const images = [
    ...new Set([...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((match) => match[1])),
  ];
  const [firstReplica] = replicas;
  const bunVersion =
    firstReplica === undefined
      ? "n/a"
      : (await run(["docker", "exec", firstReplica, "bun", "--version"])).stdout.trim();
  const collector = (await containersOf("otel-lgtm", "observability")).length > 0;
  const commit = (await run(["git", "rev-parse", "--short", "HEAD"])).stdout.trim();
  const dirty = (await run(["git", "status", "--porcelain"])).stdout.trim() !== "";
  const [counts] = await sql<
    {
      wallets: number;
      transactions: number;
      entries: number;
      pending: number;
      inbox: number;
    }[]
  >`select
      (select count(*)::int from wallets) as wallets,
      (select count(*)::int from wager_transactions) as transactions,
      (select count(*)::int from ledger_entries) as entries,
      (select count(*)::int from outbox_messages where published_at is null) as pending,
      (select count(*)::int from inbox_messages) as inbox`;
  return [
    [
      "Host",
      `${os.type()} ${os.release()}, ${cpus[0]?.model.trim() ?? "unknown CPU"} (${cpus.length} threads), ${gib(os.totalmem())}`,
    ],
    [
      "Docker",
      `${info.ServerVersion ?? "?"} on ${info.OperatingSystem ?? "?"}: ${info.NCPU ?? "?"} CPUs and ${info.MemTotal === undefined ? "?" : gib(info.MemTotal)} for every container`,
    ],
    [
      "Topology",
      `${replicas.length} replicas with every role behind nginx; PostgreSQL, LocalStack and k6 in containers on the same host`,
    ],
    ["Images", images.join(", ")],
    ["Application", `Bun ${bunVersion}; default settings (10 connections per replica)`],
    [
      "Tracing",
      collector
        ? "on, exporting to otel-lgtm (observability profile running)"
        : "on, exports dropped (observability profile not running)",
    ],
    ["Commit", `${commit}${dirty ? " (uncommitted changes)" : ""}`],
    [
      "Database before the run",
      counts === undefined
        ? "n/a"
        : `${counts.wallets} wallets, ${counts.transactions} transactions, ${counts.entries} ledger entries, ${counts.inbox} inbox rows, ${counts.pending} unpublished events`,
    ],
  ];
}

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

/** Runs `work` over every item, `concurrency` at a time. */
async function inParallel<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) {
          results[index] = await work(item);
        }
      }
    }),
  );
  return results;
}

async function openWallets(
  runId: string,
  group: string,
  count: number,
  amount: string,
): Promise<Wallet[]> {
  return inParallel(
    Array.from({ length: count }, (_, index) => `${runId}-${group}-${index}`),
    25,
    async (playerId) => {
      const response = await fetch(`${BASE_URL}/wallets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playerId, initialBalance: { amount, currency: "BRL" } }),
      });
      if (response.status !== 201) {
        throw new Error(`opening a wallet answered ${response.status}: ${await response.text()}`);
      }
      const wallet = (await response.json()) as Wallet;
      return { id: wallet.id, playerId: wallet.playerId };
    },
  );
}

interface Reading {
  readonly at: number;
  readonly outboxLagSeconds: number | undefined;
  readonly outboxPending: number | undefined;
  readonly overAttemptThreshold: number | undefined;
  readonly queueDepth: number | undefined;
}

const DEPTH_ATTRIBUTES: QueueAttributeName[] = [
  "ApproximateNumberOfMessages",
  "ApproximateNumberOfMessagesNotVisible",
  "ApproximateNumberOfMessagesDelayed",
];

/** Messages in a queue: visible, in flight and delayed. */
async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: DEPTH_ATTRIBUTES }),
  );
  return DEPTH_ATTRIBUTES.reduce((total, name) => total + Number(Attributes?.[name] ?? 0), 0);
}

async function readState(sqs: SQSClient, queueUrl: string): Promise<Reading> {
  const at = Date.now();
  const [metrics, depth] = await Promise.all([
    // Shared-state gauges are read from PostgreSQL by whichever replica answers: any will do.
    fetch(`${BASE_URL}/metrics`, { signal: AbortSignal.timeout(5000) })
      .then(async (response) => parsePrometheus(await response.text()))
      .catch(() => undefined),
    queueDepth(sqs, queueUrl).catch(() => undefined),
  ]);
  return {
    at,
    outboxLagSeconds: metrics === undefined ? undefined : gaugeValue(metrics, "outbox_lag_seconds"),
    outboxPending: metrics === undefined ? undefined : gaugeValue(metrics, "outbox_pending_events"),
    overAttemptThreshold:
      metrics === undefined
        ? undefined
        : gaugeValue(metrics, "outbox_events_over_attempt_threshold"),
    queueDepth: depth,
  };
}

function startSampler(sqs: SQSClient, queueUrl: string) {
  const readings: Reading[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const startedAt = Date.now();
      readings.push(await readState(sqs, queueUrl));
      await Bun.sleep(Math.max(0, 1000 - (Date.now() - startedAt)));
    }
  })();
  return {
    readings,
    latest: (): Reading | undefined => readings.at(-1),
    stop: async () => {
      running = false;
      await loop;
    },
  };
}

/** Copies a stream to the terminal and reports each line to `onLine`. */
async function relay(
  stream: ReadableStream<Uint8Array>,
  out: NodeJS.WriteStream,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    out.write(chunk);
    const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      onLine(part);
    }
  }
}

const IN_DOUBT_LINE = /LOAD_IN_DOUBT ([^\s"]+)/;
const SEND_UNKNOWN_LINE = /LOAD_SEND_UNKNOWN ([^\s"]+)/;

/**
 * Runs k6 in its compose container; resolves with its exit code, when the scenarios began, and
 * the outcomes k6 could not know (the keys of the transactions it left in doubt, the ids of the
 * messages whose send got no answer). `onStart` runs once the scenarios begin.
 */
async function runK6(onStart: (startedAt: number) => void): Promise<{
  code: number;
  startedAt: number | undefined;
  inDoubtKeys: string[];
  unknownSends: string[];
}> {
  // On Linux and macOS, k6 writes its summary as the current user, who owns test/load/results.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const user = uid === undefined || gid === undefined ? [] : ["--user", `${uid}:${gid}`];
  const child = Bun.spawn(
    ["docker", "compose", "--profile", "load", "run", "--rm", "-T", ...user, "k6"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  let startedAt: number | undefined;
  const inDoubtKeys: string[] = [];
  const unknownSends: string[] = [];
  const onLine = (line: string) => {
    if (startedAt === undefined && line.includes(START_MARKER)) {
      startedAt = Date.now();
      onStart(startedAt);
    }
    const inDoubt = IN_DOUBT_LINE.exec(line)?.[1];
    if (inDoubt !== undefined) {
      inDoubtKeys.push(inDoubt);
    }
    const unknownSend = SEND_UNKNOWN_LINE.exec(line)?.[1];
    if (unknownSend !== undefined) {
      unknownSends.push(unknownSend);
    }
  };
  await Promise.all([
    relay(child.stdout, process.stdout, onLine),
    relay(child.stderr, process.stderr, onLine),
  ]);
  return { code: await child.exited, startedAt, inDoubtKeys, unknownSends };
}

/** Looks up, one by one, the outcomes k6 could not know. */
async function resolveUnknowns(
  sql: SQL,
  inDoubtKeys: readonly string[],
  unknownSends: readonly string[],
): Promise<ResolvedUnknowns> {
  const stored =
    inDoubtKeys.length === 0
      ? []
      : await sql<{ status: string }[]>`
          select status from wager_transactions where idempotency_key in ${sql(inDoubtKeys)}`;
  const count = (statuses: readonly string[]) =>
    stored.filter((row) => statuses.includes(row.status)).length;
  const [inbox] =
    unknownSends.length === 0
      ? [{ count: 0 }]
      : await sql<{ count: number }[]>`
          select count(*)::int as count from inbox_messages
          where consumer_name = ${CONSUMER_NAME} and message_id in ${sql(unknownSends)}`;
  return {
    http: {
      processed: count(["PROCESSED"]),
      rejected: count(["REJECTED", "FAILED"]),
      pending: count(["PENDING_REFERENCE"]),
    },
    queueStored: inbox?.count ?? 0,
  };
}

/**
 * Every replica's metrics at the end of each phase, read while k6 runs: the increase between
 * two of them is what the replicas did during that phase.
 */
function scheduleSnapshots(
  replicas: readonly string[],
  phases: readonly Phase[],
  startedAt: number,
): { snapshots: Map<string, Promise<Map<string, Sample[]> | undefined>>; cancel: () => void } {
  const snapshots = new Map<string, Promise<Map<string, Sample[]> | undefined>>();
  const timers = phases.map((phase) =>
    setTimeout(
      () => {
        snapshots.set(
          phase.name,
          scrapeReplicas(replicas).catch(() => undefined),
        );
      },
      Math.max(0, startedAt + phase.end * 1000 - Date.now()),
    ),
  );
  return { snapshots, cancel: () => timers.forEach(clearTimeout) };
}

function secondsAfterLoad(
  at: number | undefined,
  origin: number,
  loadSeconds: number,
): number | undefined {
  return at === undefined ? undefined : Math.max(0, (at - origin) / 1000 - loadSeconds);
}

async function unpublishedEvents(sql: SQL): Promise<number> {
  const [row] = await sql<{ pending: number }[]>`
    select count(*)::int as pending from outbox_messages where published_at is null`;
  return row?.pending ?? Number.NaN;
}

/**
 * Waits until the inbound queue and the outbox are empty. Both are read at the source (SQS and
 * the database): a gauge keeps its last value when a replica fails to read it.
 */
async function waitForDrain(
  sql: SQL,
  sqs: SQSClient,
  queueUrl: string,
  timeoutSeconds: number,
): Promise<{
  queue: boolean;
  outbox: boolean;
  /** When each was first seen empty (epoch milliseconds). */
  queueAt: number | undefined;
  outboxAt: number | undefined;
}> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastReport = 0;
  let queueAt: number | undefined;
  let outboxAt: number | undefined;
  for (;;) {
    const [depth, pending] = await Promise.all([
      queueDepth(sqs, queueUrl).catch(() => undefined),
      unpublishedEvents(sql).catch(() => undefined),
    ]);
    const queue = depth === 0;
    const outbox = pending === 0;
    queueAt = queue ? (queueAt ?? Date.now()) : undefined;
    outboxAt = outbox ? (outboxAt ?? Date.now()) : undefined;
    if ((queue && outbox) || Date.now() >= deadline) {
      return { queue, outbox, queueAt, outboxAt };
    }
    if (Date.now() - lastReport >= 10_000) {
      lastReport = Date.now();
      log(
        `waiting for the drain: ${depth ?? "?"} messages in the queue, ${pending ?? "?"} unpublished events`,
      );
    }
    await Bun.sleep(1000);
  }
}

async function reconcile(
  wallets: readonly Wallet[],
): Promise<{ wallets: number; divergent: number; failed: number }> {
  const results = await inParallel(wallets, 16, async (wallet) => {
    const response = await fetch(`${BASE_URL}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });
    if (response.status !== 200) {
      return "failed";
    }
    const report = (await response.json()) as { consistent?: boolean };
    return report.consistent === true ? "consistent" : "divergent";
  });
  return {
    wallets: wallets.length,
    divergent: results.filter((result) => result === "divergent").length,
    failed: results.filter((result) => result === "failed").length,
  };
}

/** Each message's wait, from its send (in its id) until a consumer received it (the inbox row). */
async function queueWaits(sql: SQL, runId: string): Promise<number[]> {
  const rows = await sql<{ message_id: string; received_at: Date }[]>`
    select message_id, received_at from inbox_messages
    where consumer_name = ${CONSUMER_NAME} and message_id like ${`${runId}-%`}`;
  return rows.flatMap((row) => {
    const sentAt = Number(row.message_id.split("-")[1]);
    return Number.isFinite(sentAt) ? [row.received_at.getTime() - sentAt] : [];
  });
}

/** What the run stored: its transactions by provider and status, and its inbox rows. */
async function storedByRun(
  sql: SQL,
  plan: LoadPlan,
): Promise<{ http: Outcomes; queue: number; inboxRows: number }> {
  const rows = await sql<{ provider_id: string; status: string; count: number }[]>`
    select provider_id, status, count(*)::int as count from wager_transactions
    where provider_id in (${plan.providerId}, ${plan.queueProviderId})
      and external_transaction_id like ${`${plan.runId}-%`}
    group by provider_id, status`;
  const count = (provider: string, statuses: readonly string[]) =>
    rows
      .filter((row) => row.provider_id === provider && statuses.includes(row.status))
      .reduce((total, row) => total + row.count, 0);
  const [inbox] = await sql<{ count: number }[]>`
    select count(*)::int as count from inbox_messages
    where consumer_name = ${CONSUMER_NAME} and message_id like ${`${plan.runId}-%`}`;
  return {
    http: {
      processed: count(plan.providerId, ["PROCESSED"]),
      rejected: count(plan.providerId, ["REJECTED", "FAILED"]),
      pending: count(plan.providerId, ["PENDING_REFERENCE"]),
    },
    queue: rows
      .filter((row) => row.provider_id === plan.queueProviderId)
      .reduce((total, row) => total + row.count, 0),
    inboxRows: inbox?.count ?? 0,
  };
}

function clientCounts(summary: K6Summary): ClientCounts {
  const count = (metric: string) => k6Value(summary, metric, "count") ?? 0;
  return {
    decided: count("responses_decided"),
    replays: count("responses_replay"),
    processed: count("tx_processed"),
    rejected: count("tx_rejected"),
    pending: count("tx_pending"),
    inDoubt: count("tx_in_doubt"),
    networkErrors: count("responses_network_error"),
    dependencyLost: count("tx_dependency_lost"),
    serverErrors: count("responses_server_error"),
    unexpected: count("responses_unexpected"),
    parallelAnomalies: count("parallel_anomalies"),
    replayAnomalies: count("replay_anomalies"),
    queueSent: count("queue_messages_sent"),
    queueSendUnknown: count("queue_send_unknown"),
  };
}

function serverCounts(server: readonly Sample[]): ServerCounts {
  const transactions = (labels: Record<string, string>) =>
    sumOf(server, "wager_transactions_total", labels);
  return {
    httpMetrics: {
      processed: transactions({ source: "http", status: "PROCESSED" }),
      rejected:
        transactions({ source: "http", status: "REJECTED" }) +
        transactions({ source: "http", status: "FAILED" }),
      pending: transactions({ source: "http", status: "PENDING_REFERENCE" }),
    },
    httpReplays: sumOf(server, "wager_duplicates_total", {
      source: "http",
      type: "idempotent_replay",
    }),
    sqsDecided: transactions({ source: "sqs" }),
    sqsDuplicates: sumOf(server, "wager_duplicates_total", {
      source: "sqs",
      type: "duplicate_message",
    }),
    deadLettered: sumOf(server, "sqs_dead_lettered_messages_total"),
    unexpectedErrors: sumOf(server, "unexpected_errors_total"),
    reconciliationDivergences: sumOf(server, "reconciliation_divergences_total"),
  };
}

async function main(): Promise<number> {
  const defaults = QUICK ? SHORT : FULL;
  const startedAt = new Date();
  const runId = `lt${startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is not set: copy .env.example to .env (see README.md)");
  }

  const replicas = await preflight();
  const sql = new SQL(databaseUrl);
  const sqs = createSqsClient({
    region: process.env.AWS_REGION || "us-east-1",
    endpointUrl: process.env.AWS_ENDPOINT_URL || undefined,
  });
  try {
    const environment = await describeEnvironment(replicas, sql);
    const queueUrlOf = async (name: string) => {
      const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (QueueUrl === undefined) {
        throw new Error(`queue ${name} not found: run docker compose up -d --wait`);
      }
      return QueueUrl;
    };
    const queueUrl = await queueUrlOf(INBOUND_QUEUE);
    const deadLetterUrl = await queueUrlOf(DEAD_LETTER_QUEUE);
    const plan: LoadPlan = {
      runId,
      providerId: PROVIDER_ID,
      queueProviderId: QUEUE_PROVIDER_ID,
      queueUrl,
      warmupSeconds: positiveInteger("LOAD_WARMUP_SECONDS", defaults.warmupSeconds),
      steps: stepRates(defaults.steps),
      stepSeconds: positiveInteger("LOAD_STEP_SECONDS", defaults.stepSeconds),
      queueRate: positiveInteger("LOAD_QUEUE_RATE", defaults.queueRate),
      queueSeconds: positiveInteger("LOAD_QUEUE_SECONDS", defaults.queueSeconds),
      hotVus: positiveInteger("LOAD_HOT_VUS", defaults.hotVus),
      hotWallets: positiveInteger("LOAD_HOT_WALLETS", defaults.hotWallets),
      hotSeconds: positiveInteger("LOAD_HOT_SECONDS", defaults.hotSeconds),
      wallets: positiveInteger("LOAD_WALLETS", defaults.wallets),
      queueWallets: positiveInteger("LOAD_QUEUE_WALLETS", defaults.queueWallets),
    };
    const drainTimeoutSeconds = positiveInteger(
      "LOAD_DRAIN_TIMEOUT_SECONDS",
      defaults.drainTimeoutSeconds,
    );
    const phases = phasesOf(plan);
    const loadSeconds = phases.at(-1)?.end ?? 0;
    log(
      `run ${runId}: ${phases.map((phase) => phase.name).join(", ")} (${loadSeconds} s of load) on ${replicas.length} replicas`,
    );

    const sampler = startSampler(sqs, queueUrl);
    log("opening wallets");
    const wallets = {
      http: await openWallets(runId, "http", plan.wallets, "1000.00"),
      queue: await openWallets(runId, "queue", plan.queueWallets, "1000.00"),
      hot: await openWallets(runId, "hot", plan.hotWallets, "1000000.00"),
    };
    await mkdir(RESULTS, { recursive: true });
    await writeFile(join(RESULTS, "plan.json"), JSON.stringify({ plan, wallets }));
    // The openings raise two events per wallet: the first phase must not inherit them.
    const ready = await waitForDrain(sql, sqs, queueUrl, drainTimeoutSeconds);
    if (!(ready.queue && ready.outbox)) {
      throw new Error("the outbox or the inbound queue did not drain before the run");
    }

    const deadLettersBefore = await queueDepth(sqs, deadLetterUrl);
    const before = await scrapeReplicas(replicas);
    let snapshots: ReturnType<typeof scheduleSnapshots> | undefined;
    const k6 = await runK6((startedAt) => {
      snapshots = scheduleSnapshots(replicas, phases, startedAt);
    });
    snapshots?.cancel();
    log(`k6 exited with ${k6.code}; waiting for the queue and the outbox to drain`);
    const drained = await waitForDrain(sql, sqs, queueUrl, drainTimeoutSeconds);
    await sampler.stop();

    // What the replicas did during each phase: the increase from the previous phase's end. A
    // restart seen between two of these readings counts too, even if the end of the run hides it.
    const phaseServer: { phase: Phase; samples: Sample[] }[] = [];
    const phaseResets: string[] = [];
    let previous: Map<string, Sample[]> | undefined = before;
    for (const phase of phases) {
      const snapshot = await snapshots?.snapshots.get(phase.name);
      if (snapshot !== undefined && previous !== undefined) {
        const phaseDeltas = counterDeltas(previous, snapshot);
        phaseServer.push({ phase, samples: phaseDeltas.samples });
        phaseResets.push(...phaseDeltas.resets.map((reset) => `during ${phase.name}: ${reset}`));
      }
      previous = snapshot;
    }

    const origin = k6.startedAt ?? sampler.readings[0]?.at ?? Date.now();
    const states: StateSample[] = sampler.readings.map((reading) => ({
      t: (reading.at - origin) / 1000,
      outboxLagSeconds: reading.outboxLagSeconds,
      outboxPending: reading.outboxPending,
      overAttemptThreshold: reading.overAttemptThreshold,
      queueDepth: reading.queueDepth,
    }));

    log("reconciling every wallet");
    const reconciliation = await reconcile([...wallets.http, ...wallets.queue, ...wallets.hot]);
    const deltas = counterDeltas(before, await scrapeReplicas(replicas));
    const waits = await queueWaits(sql, runId);
    const stored = await storedByRun(sql, plan);
    const database: DatabaseCounts = {
      ...stored,
      dlqIncrease: (await queueDepth(sqs, deadLetterUrl)) - deadLettersBefore,
    };
    const summary = JSON.parse(
      await readFile(join(RESULTS, "k6-summary.json"), "utf8"),
    ) as K6Summary;

    const resolved = await resolveUnknowns(sql, k6.inDoubtKeys, k6.unknownSends);

    const checks: Check[] = correctnessChecks({
      k6ExitCode: k6.code,
      client: clientCounts(summary),
      server: serverCounts(deltas.samples),
      database,
      resolved,
      resets: [...deltas.resets, ...phaseResets],
      reconciliation,
      drained,
    });
    const report = renderReport({
      plan,
      command: `bun run test:load${QUICK ? " --quick" : ""}`,
      startedAt,
      environment,
      summary,
      states,
      // From the end of the load until the source (SQS, the database) was first seen empty.
      drain: {
        queue: secondsAfterLoad(drained.queueAt, origin, loadSeconds),
        outbox: secondsAfterLoad(drained.outboxAt, origin, loadSeconds),
      },
      queueWaitsMs: waits,
      server: deltas.samples,
      database,
      phaseServer,
      checks,
    });
    const path = join(RESULTS, `report-${runId}.md`);
    await writeFile(path, report);
    console.log(`\n${report}`);
    log(`report written to ${path}`);
    return checks.every((check) => check.passed) ? 0 : 1;
  } finally {
    await sql.close();
    sqs.destroy();
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`[load-test] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
