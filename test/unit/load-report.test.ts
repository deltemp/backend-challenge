import { describe, expect, test } from "bun:test";
import {
  type CheckInput,
  correctnessChecks,
  counterDeltas,
  histogramBuckets,
  histogramQuantile,
  type LoadPlan,
  parsePrometheus,
  phaseState,
  phasesOf,
  quantileOf,
  type Sample,
  secondsUntil,
  sumOf,
} from "../../scripts/load-report";

// The pure side of `bun run test:load`: what it reads from the replicas' metrics, and the
// checks that decide whether a run kept every transaction exactly once.

const METRICS = `
# HELP wager_transactions_total Transactions by entry point, kind and status.
# TYPE wager_transactions_total counter
wager_transactions_total{source="http",kind="BET",status="PROCESSED"} 10
wager_transactions_total{source="sqs",kind="BET",status="PROCESSED"} 4
# TYPE outbox_pending_events gauge
outbox_pending_events 7
# TYPE wager_processing_duration_seconds histogram
wager_processing_duration_seconds_bucket{le="0.01",source="http",outcome="processed"} 2
wager_processing_duration_seconds_bucket{le="0.1",source="http",outcome="processed"} 8
wager_processing_duration_seconds_bucket{le="+Inf",source="http",outcome="processed"} 10
wager_processing_duration_seconds_sum{source="http",outcome="processed"} 0.4
wager_processing_duration_seconds_count{source="http",outcome="processed"} 10
odd_label{path="a \\"quoted\\" value"} 1
not a sample line
`;

function sample(name: string, labels: Record<string, string>, value: number, type = "counter") {
  return { name, labels, value, type };
}

describe("parsePrometheus", () => {
  test("reads each series with its labels, value and family type", () => {
    const samples = parsePrometheus(METRICS);

    expect(samples).toContainEqual(
      sample("wager_transactions_total", { source: "http", kind: "BET", status: "PROCESSED" }, 10),
    );
    expect(samples).toContainEqual(sample("outbox_pending_events", {}, 7, "gauge"));
    expect(samples).toContainEqual(
      sample(
        "wager_processing_duration_seconds_bucket",
        { le: "+Inf", source: "http", outcome: "processed" },
        10,
        "histogram",
      ),
    );
    expect(samples).toContainEqual(sample("odd_label", { path: 'a "quoted" value' }, 1, "untyped"));
    expect(samples.some((parsed) => parsed.name === "not")).toBe(false);
  });

  test("sums the series of a metric that carry the given labels", () => {
    const samples = parsePrometheus(METRICS);

    expect(sumOf(samples, "wager_transactions_total")).toBe(14);
    expect(sumOf(samples, "wager_transactions_total", { source: "sqs" })).toBe(4);
    expect(sumOf(samples, "wager_transactions_total", { source: "retry" })).toBe(0);
  });
});

describe("counterDeltas", () => {
  const counter = (value: number, labels: Record<string, string> = { source: "http" }) =>
    sample("wager_transactions_total", labels, value);

  test("adds up each replica's increase; a series born during the run started at zero", () => {
    const before = new Map<string, Sample[]>([
      ["app-1", [counter(10)]],
      ["app-2", [counter(5)]],
    ]);
    const after = new Map<string, Sample[]>([
      ["app-1", [counter(15), counter(3, { source: "sqs" })]],
      ["app-2", [counter(9)]],
    ]);

    const deltas = counterDeltas(before, after);

    expect(deltas.resets).toEqual([]);
    expect(sumOf(deltas.samples, "wager_transactions_total", { source: "http" })).toBe(9);
    expect(sumOf(deltas.samples, "wager_transactions_total", { source: "sqs" })).toBe(3);
  });

  test("ignores gauges, which go down by nature", () => {
    const gauge = (value: number) => sample("outbox_pending_events", {}, value, "gauge");

    const deltas = counterDeltas(
      new Map([["app-1", [gauge(100)]]]),
      new Map([["app-1", [gauge(0)]]]),
    );

    expect(deltas).toEqual({ samples: [], resets: [] });
  });

  test("a counter that went down, or a replica that changed, makes the deltas untrustworthy", () => {
    const deltas = counterDeltas(
      new Map([
        ["app-1", [counter(10)]],
        ["app-2", [counter(1)]],
      ]),
      new Map([
        ["app-1", [counter(4)]],
        ["app-3", [counter(1)]],
      ]),
    );

    expect(deltas.resets).toHaveLength(3);
    expect(deltas.resets.join("; ")).toContain("went down on app-1");
    expect(deltas.resets.join("; ")).toContain("app-2 disappeared");
    expect(deltas.resets.join("; ")).toContain("app-3 appeared");
  });
});

describe("quantiles", () => {
  test("a histogram quantile interpolates inside the bucket that holds the rank", () => {
    const buckets = histogramBuckets(
      parsePrometheus(METRICS),
      "wager_processing_duration_seconds",
      {
        source: "http",
        outcome: "processed",
      },
    );

    // 10 observations: 2 up to 10 ms, 6 more up to 100 ms, 2 above.
    expect(histogramQuantile(0.2, buckets)).toBeCloseTo(0.01, 10);
    expect(histogramQuantile(0.5, buckets)).toBeCloseTo(0.01 + 0.09 * (3 / 6), 10);
    // The rank falls in the +Inf bucket: the highest finite bound is all that is known.
    expect(histogramQuantile(0.99, buckets)).toBe(0.1);
    expect(histogramQuantile(0.5, [])).toBeUndefined();
  });

  test("a quantile of raw values interpolates between the closest ranks", () => {
    expect(quantileOf([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantileOf([4, 1, 3, 2], 1)).toBe(4);
    expect(quantileOf([7], 0.99)).toBe(7);
    expect(quantileOf([], 0.5)).toBeUndefined();
  });
});

describe("phases and readings", () => {
  const plan: LoadPlan = {
    runId: "lt1",
    providerId: "load-test",
    queueProviderId: "load-test-queue",
    queueUrl: "queue",
    warmupSeconds: 10,
    steps: [25, 50],
    stepSeconds: 30,
    queueRate: 20,
    queueSeconds: 20,
    hotVus: 5,
    hotWallets: 2,
    hotSeconds: 15,
    wallets: 10,
    queueWallets: 5,
  };

  test("the phases follow each other in the order load.js runs them", () => {
    expect(phasesOf(plan).map(({ name, start, end }) => [name, start, end])).toEqual([
      ["warmup", 0, 10],
      ["queue", 10, 30],
      ["step_25", 30, 60],
      ["step_50", 60, 90],
      ["hot_wallet", 90, 105],
    ]);
  });

  test("a phase's readings, and the time until a condition holds after a moment", () => {
    const reading = (t: number, lag: number, pending: number) => ({
      t,
      outboxLagSeconds: lag,
      outboxPending: pending,
      overAttemptThreshold: 0,
      queueDepth: 0,
    });
    const states = [
      reading(5, 0.2, 3),
      reading(32, 1.5, 40),
      reading(59, 0.5, 9),
      reading(110, 0, 0),
    ];
    const step25 = phasesOf(plan).find((phase) => phase.name === "step_25");
    if (step25 === undefined) {
      throw new Error("no step phase");
    }

    expect(phaseState(states, step25)).toEqual({
      maxLagSeconds: 1.5,
      lagAtEndSeconds: 0.5,
      maxPending: 40,
      maxQueueDepth: 0,
    });
    expect(secondsUntil(states, 105, (state) => state.outboxPending === 0)).toBe(5);
    expect(secondsUntil(states, 120, (state) => state.outboxPending === 0)).toBeUndefined();
  });
});

describe("correctnessChecks", () => {
  const outcomes = { processed: 100, rejected: 10, pending: 0 };
  const none = { processed: 0, rejected: 0, pending: 0 };
  const consistent: CheckInput = {
    k6ExitCode: 0,
    client: {
      ...outcomes,
      decided: 120,
      replays: 10,
      inDoubt: 0,
      networkErrors: 0,
      dependencyLost: 0,
      serverErrors: 0,
      unexpected: 0,
      parallelAnomalies: 0,
      replayAnomalies: 0,
      queueSent: 50,
      queueSendUnknown: 0,
    },
    server: {
      httpMetrics: outcomes,
      httpReplays: 10,
      sqsDecided: 50,
      sqsDuplicates: 0,
      deadLettered: 0,
      unexpectedErrors: 0,
      reconciliationDivergences: 0,
    },
    database: { http: outcomes, queue: 50, inboxRows: 50, dlqIncrease: 0 },
    resolved: { http: none, queueStored: 0 },
    resets: [],
    reconciliation: { wallets: 20, divergent: 0, failed: 0 },
    drained: { queue: true, outbox: true },
  };

  const failed = (input: CheckInput) =>
    correctnessChecks(input)
      .filter((check) => !check.passed)
      .map((check) => check.name);

  const STORED_ONCE = "HTTP: each transaction stored once, none lost";
  const QUEUE = "Queue: each message stored once, none lost";

  test("a run whose counts agree passes every check", () => {
    expect(failed(consistent)).toEqual([]);
  });

  test("an extra stored transaction passes only when the lookup of a transaction in doubt found it", () => {
    const extra = {
      ...consistent,
      client: { ...consistent.client, inDoubt: 1 },
      database: { ...consistent.database, http: { ...outcomes, processed: 101 } },
      server: { ...consistent.server, httpMetrics: { ...outcomes, processed: 101 } },
    };

    expect(failed(extra)).toContain(STORED_ONCE);
    expect(
      failed({ ...extra, resolved: { http: { ...none, processed: 1 }, queueStored: 0 } }),
    ).not.toContain(STORED_ONCE);
  });

  test("a lost transaction fails even when a transaction in doubt was stored in its place", () => {
    // k6 saw L processed (it was not stored); D, left in doubt, was stored and found.
    const swapped = {
      ...consistent,
      client: { ...consistent.client, inDoubt: 1 },
      resolved: { http: { ...none, processed: 1 }, queueStored: 0 },
    };

    expect(failed(swapped)).toContain(STORED_ONCE);
  });

  test("a counter that missed a stored transaction needs a transaction that lost a dependency", () => {
    const missed = {
      ...consistent,
      server: { ...consistent.server, httpMetrics: { ...outcomes, processed: 99 } },
    };
    const counters = "HTTP: the replicas' counters match the database";

    expect(failed(missed)).toContain(counters);
    expect(
      failed({ ...missed, client: { ...consistent.client, dependencyLost: 1 } }),
    ).not.toContain(counters);
  });

  test("the queue: a message stored twice or lost, or counted short without a redelivery, fails", () => {
    const withQueue = (database: Partial<CheckInput["database"]>) => ({
      ...consistent,
      database: { ...consistent.database, ...database },
    });
    expect(failed(withQueue({ queue: 51, inboxRows: 51 }))).toContain(QUEUE);
    expect(
      failed({
        ...withQueue({ queue: 51, inboxRows: 51 }),
        resolved: { http: none, queueStored: 1 },
      }),
    ).toContain(QUEUE); // the consumers counted 50 and nothing came back
    expect(failed(withQueue({ inboxRows: 49 }))).toContain(QUEUE);

    const counted = (sqsDecided: number, sqsDuplicates: number) => ({
      ...consistent,
      server: { ...consistent.server, sqsDecided, sqsDuplicates },
    });
    expect(failed(counted(49, 0))).toContain(QUEUE);
    expect(failed(counted(49, 1))).not.toContain(QUEUE);
    expect(failed(counted(51, 0))).toContain(QUEUE);
  });

  test("a dead letter, a divergent wallet or a backlog fail", () => {
    expect(failed({ ...consistent, database: { ...consistent.database, dlqIncrease: 1 } })).toEqual(
      ["No message dead-lettered"],
    );
    expect(
      failed({ ...consistent, reconciliation: { wallets: 20, divergent: 1, failed: 0 } }),
    ).toEqual(["Every balance equals its ledger"]);
    expect(failed({ ...consistent, drained: { queue: true, outbox: false } })).toEqual([
      "Inbound queue and outbox drained",
    ]);
  });
});

describe("restart detection", () => {
  test("a replica whose process start time changed restarted, even if its counters grew", () => {
    const snapshot = (started: number, transactions: number) => [
      sample("process_start_time_seconds", {}, started, "gauge"),
      sample("wager_transactions_total", { source: "http" }, transactions),
    ];

    const deltas = counterDeltas(
      new Map([["app-1", snapshot(1000, 5)]]),
      new Map([["app-1", snapshot(1200, 40)]]),
    );

    expect(deltas.resets).toEqual(["app-1 restarted: its process start time changed"]);
  });
});
