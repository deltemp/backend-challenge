// Pure functions behind `bun run test:load` (scripts/load-test.ts): reading the replicas'
// Prometheus metrics, the statistics of the run, the correctness checks and the Markdown report.
// Everything measured here is a count or a duration: no money amount is ever read or computed.

/** One series of the Prometheus text format. */
export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  /** The `# TYPE` of its metric family: only counters and histograms only ever go up. */
  readonly type: string;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const TYPE_LINE = /^#\s*TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\w+)/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
const FAMILY_SUFFIX = /_(?:bucket|count|sum)$/;

function unescapeLabel(value: string): string {
  return value.replace(/\\(.)/g, (_, escaped: string) => (escaped === "n" ? "\n" : escaped));
}

/** Parses the Prometheus text exposition format; malformed lines are skipped. */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  const types = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const typeLine = TYPE_LINE.exec(trimmed);
    if (typeLine?.[1] !== undefined && typeLine[2] !== undefined) {
      types.set(typeLine[1], typeLine[2]);
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const match = SAMPLE_LINE.exec(trimmed);
    if (match === null) {
      continue;
    }
    const [, name, labelText, rawValue] = match;
    if (name === undefined || rawValue === undefined) {
      continue;
    }
    const value = rawValue === "+Inf" ? Number.POSITIVE_INFINITY : Number(rawValue);
    if (Number.isNaN(value)) {
      continue;
    }
    const labels: Record<string, string> = {};
    for (const [, key, labelValue] of (labelText ?? "").matchAll(LABEL_PAIR)) {
      if (key !== undefined && labelValue !== undefined) {
        labels[key] = unescapeLabel(labelValue);
      }
    }
    const type = types.get(name) ?? types.get(name.replace(FAMILY_SUFFIX, "")) ?? "untyped";
    samples.push({ name, labels, value, type });
  }
  return samples;
}

function isMonotonic(sample: Sample): boolean {
  return sample.type === "counter" || sample.type === "histogram";
}

/** A stable key for a series: its name and its labels in order. */
export function seriesKey(sample: Pick<Sample, "name" | "labels">): string {
  const labels = Object.keys(sample.labels)
    .sort()
    .map((key) => `${key}=${JSON.stringify(sample.labels[key])}`)
    .join(",");
  return `${sample.name}{${labels}}`;
}

function matches(sample: Sample, name: string, labels: Readonly<Record<string, string>>): boolean {
  return (
    sample.name === name &&
    Object.entries(labels).every(([key, value]) => sample.labels[key] === value)
  );
}

/** The sum of every series of a metric whose labels include `labels`. */
export function sumOf(
  samples: readonly Sample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number {
  return samples
    .filter((sample) => matches(sample, name, labels))
    .reduce((total, sample) => total + sample.value, 0);
}

/** The first value of a metric, for gauges every replica reports alike. */
export function gaugeValue(
  samples: readonly Sample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number | undefined {
  return samples.find((sample) => matches(sample, name, labels))?.value;
}

export interface CounterDeltas {
  /** The increase of every series over the run, summed across replicas. */
  readonly samples: Sample[];
  /** Why the deltas cannot be trusted: a replica that restarted or changed. */
  readonly resets: string[];
}

const START_TIME = "process_start_time_seconds";

/**
 * The increase of the counters and histograms of each replica between two snapshots, summed
 * across replicas; gauges are left out. prom-client creates a labelled series at its first
 * increment, so a series missing before started at zero. A process that restarted in between
 * (its start time changed, or a counter went down) makes the deltas untrustworthy: its counters
 * started over.
 */
export function counterDeltas(
  before: ReadonlyMap<string, readonly Sample[]>,
  after: ReadonlyMap<string, readonly Sample[]>,
): CounterDeltas {
  const resets: string[] = [];
  const totals = new Map<string, Sample>();
  for (const replica of new Set([...before.keys(), ...after.keys()])) {
    const start = before.get(replica);
    const end = after.get(replica);
    if (start === undefined || end === undefined) {
      resets.push(`replica ${replica} ${start === undefined ? "appeared" : "disappeared"}`);
      continue;
    }
    const startedBefore = gaugeValue(start, START_TIME);
    const startedAfter = gaugeValue(end, START_TIME);
    if (startedBefore !== startedAfter) {
      resets.push(`${replica} restarted: its process start time changed`);
    }
    const startValues = new Map(start.map((sample) => [seriesKey(sample), sample.value]));
    for (const sample of end.filter(isMonotonic)) {
      const key = seriesKey(sample);
      const delta = sample.value - (startValues.get(key) ?? 0);
      if (delta < 0) {
        resets.push(`${key} went down on ${replica}: the process restarted`);
        continue;
      }
      const total = totals.get(key);
      totals.set(key, { ...sample, value: (total?.value ?? 0) + delta });
    }
  }
  return { samples: [...totals.values()], resets };
}

/**
 * The quantile of a Prometheus histogram, as `histogram_quantile` computes it: linear
 * interpolation inside the bucket that holds the rank. Undefined when there is no observation.
 */
export function histogramQuantile(
  quantile: number,
  buckets: readonly { readonly le: number; readonly count: number }[],
): number | undefined {
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const total = sorted.at(-1)?.count ?? 0;
  if (total <= 0) {
    return undefined;
  }
  const rank = quantile * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const bucket of sorted) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) {
        return lowerBound;
      }
      const inBucket = bucket.count - lowerCount;
      return inBucket <= 0
        ? bucket.le
        : lowerBound + (bucket.le - lowerBound) * ((rank - lowerCount) / inBucket);
    }
    lowerBound = bucket.le;
    lowerCount = bucket.count;
  }
  return lowerBound;
}

/** The buckets of a histogram, summed across the series that match `labels`. */
export function histogramBuckets(
  samples: readonly Sample[],
  name: string,
  labels: Readonly<Record<string, string>>,
): { le: number; count: number }[] {
  const byBound = new Map<number, number>();
  for (const sample of samples) {
    if (!matches(sample, `${name}_bucket`, labels) || sample.labels.le === undefined) {
      continue;
    }
    const le = sample.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample.labels.le);
    byBound.set(le, (byBound.get(le) ?? 0) + sample.value);
  }
  return [...byBound.entries()].map(([le, count]) => ({ le, count }));
}

/** The quantile of raw values, interpolating between the closest ranks as k6 does. */
export function quantileOf(values: readonly number[], quantile: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

// --- The run ---

export interface Phase {
  readonly name: string;
  /** Seconds from the start of the scenarios. */
  readonly start: number;
  readonly end: number;
  /** What the phase applies, for the report. */
  readonly load: string;
}

export interface LoadPlan {
  readonly runId: string;
  readonly providerId: string;
  readonly queueUrl: string;
  readonly warmupSeconds: number;
  readonly steps: readonly number[];
  readonly stepSeconds: number;
  readonly queueRate: number;
  readonly queueSeconds: number;
  readonly hotVus: number;
  readonly hotWallets: number;
  readonly hotSeconds: number;
  readonly wallets: number;
  readonly queueWallets: number;
  /** The provider of the queue rounds, so the database tells them from the HTTP ones. */
  readonly queueProviderId: string;
}

/**
 * The phases of a plan, in the order load.js runs them: the queue while the system is still
 * calm, then the HTTP steps up to saturation, then the hot wallets.
 */
export function phasesOf(plan: LoadPlan): Phase[] {
  const phases: Phase[] = [];
  let start = 0;
  const add = (name: string, seconds: number, load: string) => {
    phases.push({ name, start, end: start + seconds, load });
    start += seconds;
  };
  add("warmup", plan.warmupSeconds, `${plan.steps[0] ?? 0} rounds/s over HTTP`);
  add("queue", plan.queueSeconds, `${plan.queueRate} rounds/s as messages`);
  for (const rate of plan.steps) {
    add(`step_${rate}`, plan.stepSeconds, `${rate} rounds/s over HTTP`);
  }
  add(
    "hot_wallet",
    plan.hotSeconds,
    `${plan.hotVus} users betting without pause on ${plan.hotWallets} wallets`,
  );
  return phases;
}

/** One reading of the shared-state gauges and of the inbound queue. */
export interface StateSample {
  /** Seconds from the start of the scenarios (negative before it). */
  readonly t: number;
  readonly outboxLagSeconds: number | undefined;
  readonly outboxPending: number | undefined;
  readonly overAttemptThreshold: number | undefined;
  readonly queueDepth: number | undefined;
}

export interface PhaseState {
  readonly maxLagSeconds: number | undefined;
  readonly lagAtEndSeconds: number | undefined;
  readonly maxPending: number | undefined;
  readonly maxQueueDepth: number | undefined;
}

function maxOf(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}

/** The outbox and queue readings taken during a phase. */
export function phaseState(samples: readonly StateSample[], phase: Phase): PhaseState {
  const during = samples.filter((sample) => sample.t >= phase.start && sample.t < phase.end);
  return {
    maxLagSeconds: maxOf(during.map((sample) => sample.outboxLagSeconds)),
    lagAtEndSeconds: during.at(-1)?.outboxLagSeconds,
    maxPending: maxOf(during.map((sample) => sample.outboxPending)),
    maxQueueDepth: maxOf(during.map((sample) => sample.queueDepth)),
  };
}

/** Seconds after `from` until the first reading where `drained` holds; undefined if never. */
export function secondsUntil(
  samples: readonly StateSample[],
  from: number,
  drained: (sample: StateSample) => boolean,
): number | undefined {
  const first = samples.find((sample) => sample.t >= from && drained(sample));
  return first === undefined ? undefined : Math.max(0, first.t - from);
}

// --- Correctness ---

/** Transactions by how they ended. */
export interface Outcomes {
  readonly processed: number;
  /** REJECTED, or FAILED. */
  readonly rejected: number;
  readonly pending: number;
}

export interface ClientCounts extends Outcomes {
  /** Answers with a decision (200, 202, 422), replays included. */
  readonly decided: number;
  readonly replays: number;
  /** Transactions without a decision that may have committed. */
  readonly inDoubt: number;
  /** Answers lost (no response). */
  readonly networkErrors: number;
  /** Transactions that met a 503 DEPENDENCY_UNAVAILABLE on some attempt. */
  readonly dependencyLost: number;
  readonly serverErrors: number;
  readonly unexpected: number;
  readonly parallelAnomalies: number;
  readonly replayAnomalies: number;
  readonly queueSent: number;
  /** Sends that may have enqueued their message (no answer, or a 5xx). */
  readonly queueSendUnknown: number;
}

export interface ServerCounts {
  /** New HTTP decisions counted by the replicas (`wager_transactions_total`). */
  readonly httpMetrics: Outcomes;
  readonly httpReplays: number;
  /** Transactions the consumers decided, by `wager_transactions_total`. */
  readonly sqsDecided: number;
  /** Redelivered messages the consumers answered from the inbox. */
  readonly sqsDuplicates: number;
  readonly deadLettered: number;
  readonly unexpectedErrors: number;
  readonly reconciliationDivergences: number;
}

export interface DatabaseCounts {
  /** This run's HTTP transactions stored, by status. */
  readonly http: Outcomes;
  /** This run's queue transactions stored. */
  readonly queue: number;
  /** Inbox rows of the messages this run sent. */
  readonly inboxRows: number;
  /** Messages the dead-letter queue gained during the run. */
  readonly dlqIncrease: number;
}

/** What the database holds of the outcomes k6 could not know, looked up one by one. */
export interface ResolvedUnknowns {
  /** The transactions left in doubt that the database holds, by status. */
  readonly http: Outcomes;
  /** The messages whose send got no answer that were stored all the same. */
  readonly queueStored: number;
}

export interface CheckInput {
  readonly k6ExitCode: number;
  readonly client: ClientCounts;
  readonly server: ServerCounts;
  readonly database: DatabaseCounts;
  readonly resolved: ResolvedUnknowns;
  readonly resets: readonly string[];
  readonly reconciliation: {
    readonly wallets: number;
    readonly divergent: number;
    readonly failed: number;
  };
  /** Read from the database and SQS, not from a gauge that keeps its last value. */
  readonly drained: { readonly queue: boolean; readonly outbox: boolean };
}

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** `value` within [low, low + slack]. */
function within(value: number, low: number, slack: number): boolean {
  return value >= low && value <= low + slack;
}

const STATUSES = ["processed", "rejected", "pending"] as const;

/**
 * `actual` holds at least `expected` of every status, and at most `slack` more in all: the
 * slack is shared, so one unknown transaction can explain one extra row, never one per status.
 */
function atLeastWithSharedSlack(actual: Outcomes, expected: Outcomes, slack: number): boolean {
  const extra = STATUSES.map((status) => actual[status] - expected[status]);
  return extra.every((difference) => difference >= 0) && extra.reduce((a, b) => a + b, 0) <= slack;
}

function outcomesText(outcomes: Outcomes): string {
  return `${outcomes.processed} processed, ${outcomes.rejected} rejected, ${outcomes.pending} pending`;
}

function sameOutcomes(a: Outcomes, b: Outcomes): boolean {
  return STATUSES.every((status) => a[status] === b[status]);
}

/**
 * What must hold after any run, however loaded: every transaction stored once and none lost,
 * every balance equal to its ledger, nothing left behind. The database is the reference, and
 * the comparisons are exact: what k6 could not know (a transaction left in doubt, a send without
 * an answer) was looked up in the database one by one.
 */
export function correctnessChecks(input: CheckInput): Check[] {
  const { client, server, database, resolved } = input;
  const expectedHttp: Outcomes = {
    processed: client.processed + resolved.http.processed,
    rejected: client.rejected + resolved.http.rejected,
    pending: client.pending + resolved.http.pending,
  };
  const expectedQueue = client.queueSent + resolved.queueStored;
  const uncountedQueue = database.queue - server.sqsDecided;
  const httpDecisions =
    server.httpMetrics.processed +
    server.httpMetrics.rejected +
    server.httpMetrics.pending +
    server.httpReplays;
  return [
    {
      name: "k6 thresholds (no 500, no unexpected answer, no anomaly)",
      passed: input.k6ExitCode === 0,
      detail: `k6 exited with ${input.k6ExitCode}`,
    },
    {
      name: "No server error",
      passed: client.serverErrors === 0 && server.unexpectedErrors === 0,
      detail: `${client.serverErrors} HTTP 5xx other than 503, ${server.unexpectedErrors} unexpected errors counted by the replicas`,
    },
    {
      name: "HTTP: each transaction stored once, none lost",
      passed: sameOutcomes(database.http, expectedHttp),
      detail: `database: ${outcomesText(database.http)}; k6: ${outcomesText(client)}, and of its ${client.inDoubt} in doubt the database holds ${outcomesText(resolved.http)}`,
    },
    {
      name: "HTTP: the replicas' counters match the database",
      // A counter misses a stored transaction only when the use case failed after its commit
      // (a dependency lost at COMMIT answers 503 DEPENDENCY_UNAVAILABLE): once per transaction.
      passed: atLeastWithSharedSlack(database.http, server.httpMetrics, client.dependencyLost),
      detail: `counters: ${outcomesText(server.httpMetrics)}; ${client.dependencyLost} transactions met DEPENDENCY_UNAVAILABLE`,
    },
    {
      name: "HTTP: every answer accounted for",
      passed:
        within(httpDecisions, client.decided, client.networkErrors) &&
        within(server.httpReplays, client.replays, client.networkErrors),
      detail: `${httpDecisions} decisions counted by the replicas, ${client.decided} answers received (${client.networkErrors} lost); replays ${server.httpReplays} / ${client.replays}`,
    },
    {
      name: "Queue: each message stored once, none lost",
      // The consumers miss counting a stored message only when its processing failed after the
      // commit; the message then came back and was answered from the inbox, as a duplicate.
      passed:
        database.queue === expectedQueue &&
        database.inboxRows === database.queue &&
        uncountedQueue >= 0 &&
        uncountedQueue <= server.sqsDuplicates,
      detail: `${client.queueSent} messages sent (${client.queueSendUnknown} sends unknown, ${resolved.queueStored} of them stored), ${database.queue} transactions and ${database.inboxRows} inbox rows stored, ${server.sqsDecided} counted by the consumers, ${server.sqsDuplicates} redelivered`,
    },
    {
      name: "No message dead-lettered",
      passed: server.deadLettered === 0 && database.dlqIncrease === 0,
      detail: `${server.deadLettered} moved by the consumers, ${database.dlqIncrease} more in the dead-letter queue`,
    },
    {
      name: "Every balance equals its ledger",
      passed:
        input.reconciliation.divergent === 0 &&
        input.reconciliation.failed === 0 &&
        server.reconciliationDivergences === 0,
      detail: `${input.reconciliation.wallets} wallets reconciled, ${input.reconciliation.divergent} divergent, ${input.reconciliation.failed} failed`,
    },
    {
      name: "Inbound queue and outbox drained",
      passed: input.drained.queue && input.drained.outbox,
      detail: `queue ${input.drained.queue ? "drained" : "NOT drained"}, outbox ${input.drained.outbox ? "drained" : "NOT drained"}`,
    },
    {
      name: "No replica restarted",
      passed: input.resets.length === 0,
      detail: input.resets.length === 0 ? "counters only went up" : input.resets.join("; "),
    },
    {
      name: "Idempotency races and replays",
      passed: client.parallelAnomalies === 0 && client.replayAnomalies === 0,
      detail: `${client.parallelAnomalies} race anomalies, ${client.replayAnomalies} replay anomalies`,
    },
  ];
}

// --- Report ---

export function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

export function formatSeconds(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(1)} s`;
}

export function formatRate(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toFixed(1);
}

export function formatPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The part of k6's end-of-test summary the report reads. */
export interface K6Summary {
  readonly metrics: Readonly<
    Record<string, { readonly values: Readonly<Record<string, number | undefined>> }>
  >;
}

export function k6Value(summary: K6Summary, metric: string, stat: string): number | undefined {
  return summary.metrics[metric]?.values[stat];
}

function k6Count(summary: K6Summary, metric: string): number {
  return k6Value(summary, metric, "count") ?? 0;
}

export interface ReportInput {
  readonly plan: LoadPlan;
  readonly command: string;
  readonly startedAt: Date;
  /** Label and value rows describing where the run happened. */
  readonly environment: readonly (readonly [string, string])[];
  readonly summary: K6Summary;
  readonly states: readonly StateSample[];
  /** Seconds after the end of the load until each drained; undefined if it did not. */
  readonly drain: { readonly queue: number | undefined; readonly outbox: number | undefined };
  /** Each message's wait, from its send until a consumer started processing it. */
  readonly queueWaitsMs: readonly number[];
  /** Counter increases over the run, summed across replicas. */
  readonly server: readonly Sample[];
  /** What the run left in the database and the dead-letter queue. */
  readonly database: DatabaseCounts;
  /** Counter increases during each phase, summed across replicas. */
  readonly phaseServer: readonly { readonly phase: Phase; readonly samples: readonly Sample[] }[];
  readonly checks: readonly Check[];
}

function httpPhaseRows(input: ReportInput, phases: readonly Phase[]): string[][] {
  const { summary } = input;
  return phases
    .filter((phase) => phase.name !== "queue")
    .map((phase) => {
      const seconds = phase.end - phase.start;
      const scenario = `scenario:${phase.name}`;
      const latency = `http_req_duration{kind:submit,${scenario}}`;
      const decided =
        k6Count(summary, `tx_processed{${scenario}}`) +
        k6Count(summary, `tx_rejected{${scenario}}`);
      const state = phaseState(input.states, phase);
      return [
        phase.name,
        phase.name === "hot_wallet"
          ? `${input.plan.hotVus} users`
          : (phase.load.split(" ")[0] ?? ""),
        formatRate(k6Count(summary, `iterations{${scenario}}`) / seconds),
        String(k6Count(summary, `dropped_iterations{${scenario}}`)),
        formatRate(k6Count(summary, `http_reqs{kind:submit,${scenario}}`) / seconds),
        formatRate(decided / seconds),
        formatMs(k6Value(summary, latency, "med")),
        formatMs(k6Value(summary, latency, "p(95)")),
        formatMs(k6Value(summary, latency, "p(99)")),
        formatMs(k6Value(summary, latency, "max")),
        formatPercent(k6Value(summary, `http_req_failed{kind:submit,${scenario}}`, "rate")),
        String(
          k6Count(summary, `responses_wallet_busy{${scenario}}`) +
            k6Count(summary, `responses_dependency_unavailable{${scenario}}`),
        ),
        formatSeconds(state.maxLagSeconds),
      ];
    });
}

/** Processing time of each source and outcome the replicas recorded in each phase. */
function serverLatencyRows(phaseServer: ReportInput["phaseServer"]): string[][] {
  return phaseServer.flatMap(({ phase, samples }) => {
    const groups = new Map<string, { source: string; outcome: string }>();
    for (const sample of samples) {
      const { source, outcome } = sample.labels;
      if (
        sample.name === "wager_processing_duration_seconds_count" &&
        source !== undefined &&
        outcome !== undefined &&
        sample.value > 0
      ) {
        groups.set(`${source}/${outcome}`, { source, outcome });
      }
    }
    return [...groups.values()]
      .sort((a, b) => `${a.source}/${a.outcome}`.localeCompare(`${b.source}/${b.outcome}`))
      .map(({ source, outcome }) => {
        const labels = { source, outcome };
        const buckets = histogramBuckets(samples, "wager_processing_duration_seconds", labels);
        const milliseconds = (quantile: number) => {
          const value = histogramQuantile(quantile, buckets);
          return value === undefined ? undefined : value * 1000;
        };
        return [
          phase.name,
          `${source} ${outcome}`,
          String(sumOf(samples, "wager_processing_duration_seconds_count", labels)),
          formatMs(milliseconds(0.5)),
          formatMs(milliseconds(0.95)),
          formatMs(milliseconds(0.99)),
        ];
      });
  });
}

function labelled(server: readonly Sample[], name: string, label: string): string {
  const totals = new Map<string, number>();
  for (const sample of server) {
    if (sample.name === name && sample.value > 0) {
      const key = sample.labels[label] ?? "";
      totals.set(key, (totals.get(key) ?? 0) + sample.value);
    }
  }
  return totals.size === 0
    ? "0"
    : [...totals.entries()].map(([key, value]) => `${key}: ${value}`).join(", ");
}

function rejectionsByCode(summary: K6Summary): string {
  const codes = Object.keys(summary.metrics)
    .map((metric) => /^tx_rejected\{code:([A-Z_]+)\}$/.exec(metric)?.[1])
    .filter((code): code is string => code !== undefined)
    .map((code) => [code, k6Count(summary, `tx_rejected{code:${code}}`)] as const)
    .filter(([, count]) => count > 0);
  return codes.length === 0 ? "none" : codes.map(([code, count]) => `${code}: ${count}`).join(", ");
}

function timeline(input: ReportInput, phases: readonly Phase[]): string[][] {
  const rows: string[][] = [];
  let next = 0;
  for (const sample of input.states) {
    if (sample.t < next) {
      continue;
    }
    next = Math.floor(sample.t / 10) * 10 + 10;
    const phase = phases.find(
      (candidate) => sample.t >= candidate.start && sample.t < candidate.end,
    );
    rows.push([
      `${Math.round(sample.t)} s`,
      phase?.name ?? "drain",
      formatSeconds(sample.outboxLagSeconds),
      sample.outboxPending === undefined ? "n/a" : String(sample.outboxPending),
      sample.queueDepth === undefined ? "n/a" : String(sample.queueDepth),
    ]);
  }
  return rows;
}

/** The Markdown report of one run. */
export function renderReport(input: ReportInput): string {
  const { plan, summary, server } = input;
  const phases = phasesOf(plan);
  const queuePhase = phases.find((phase) => phase.name === "queue");
  const queueSent = k6Count(summary, "queue_messages_sent");
  const queueState = queuePhase === undefined ? undefined : phaseState(input.states, queuePhase);
  const queueDrainedAfter =
    queuePhase === undefined
      ? undefined
      : secondsUntil(input.states, queuePhase.end, (sample) => sample.queueDepth === 0);
  const hotPhase = phases.find((phase) => phase.name === "hot_wallet");
  const hotDecided =
    k6Count(summary, "tx_processed{scenario:hot_wallet}") +
    k6Count(summary, "tx_rejected{scenario:hot_wallet}");
  const passed = input.checks.every((check) => check.passed);

  return [
    `# Load test report: ${plan.runId}`,
    "",
    `Started ${input.startedAt.toISOString()} with \`${input.command}\`. Correctness: **${passed ? "every check passed" : "FAILED"}**.`,
    "",
    "## Environment",
    "",
    table(
      ["", ""],
      input.environment.map(([label, value]) => [label, value]),
    ),
    "",
    "## Plan",
    "",
    "A round over HTTP is a BET settled by a WIN (45%), a LOSS (45%) or a REFUND (10%); 5% of the WINs are rolled back, 5% of the settlements are resent on purpose and 5% of the BETs are sent twice at once. Each phase runs alone, in this order:",
    "",
    table(
      ["Phase", "Load", "Duration"],
      phases.map((phase) => [phase.name, phase.load, `${phase.end - phase.start} s`]),
    ),
    "",
    `${plan.wallets} wallets take the HTTP rounds, ${plan.queueWallets} the queue rounds and ${plan.hotWallets} the hot-wallet bets. Latency is measured by k6 through nginx; an error is a 5xx or no answer. A 503 is resent with the same key after its \`Retry-After\`, as a provider would.`,
    "",
    "## HTTP phases",
    "",
    table(
      [
        "Phase",
        "Target",
        "Rounds/s",
        "Dropped rounds",
        "Requests/s",
        "Decided tx/s",
        "p50",
        "p95",
        "p99",
        "max",
        "Errors",
        "503s",
        "Outbox lag (max)",
      ],
      httpPhaseRows(input, phases),
    ),
    "",
    hotPhase === undefined
      ? ""
      : `Hot wallet: ${formatRate(hotDecided / (hotPhase.end - hotPhase.start) / plan.hotWallets)} decided transactions/s per wallet; time to a decision including resends p99 ${formatMs(k6Value(summary, "settle_ms{scenario:hot_wallet}", "p(99)"))}.`,
    "",
    "## Queue",
    "",
    table(
      [
        "Messages sent",
        "Sends unknown / refused",
        "Wait p50",
        "Wait p95",
        "Wait p99",
        "Wait max",
        "Max depth",
        "Drained after the phase",
      ],
      [
        [
          String(queueSent),
          `${k6Count(summary, "queue_send_unknown")} / ${k6Count(summary, "queue_send_refused")}`,
          formatMs(quantileOf(input.queueWaitsMs, 0.5)),
          formatMs(quantileOf(input.queueWaitsMs, 0.95)),
          formatMs(quantileOf(input.queueWaitsMs, 0.99)),
          formatMs(quantileOf(input.queueWaitsMs, 1)),
          queueState?.maxQueueDepth === undefined ? "n/a" : String(queueState.maxQueueDepth),
          formatSeconds(queueDrainedAfter),
        ],
      ],
    ),
    "",
    `The wait runs from the send to the moment a consumer started processing the message (the inbox row's \`received_at\`), measured for every message. SendMessage itself took p95 ${formatMs(k6Value(summary, "http_req_duration{kind:sqs}", "p(95)"))}.`,
    "",
    "## Outbox",
    "",
    table(
      ["Phase", "Lag max", "Lag at the end", "Pending max"],
      phases.map((phase) => {
        const state = phaseState(input.states, phase);
        return [
          phase.name,
          formatSeconds(state.maxLagSeconds),
          formatSeconds(state.lagAtEndSeconds),
          state.maxPending === undefined ? "n/a" : String(state.maxPending),
        ];
      }),
    ),
    "",
    `After the last phase the outbox drained in ${formatSeconds(input.drain.outbox)} and the inbound queue in ${formatSeconds(input.drain.queue)}. Readings every 10 seconds (from \`outbox_lag_seconds\`, \`outbox_pending_events\` and the inbound queue's depth):`,
    "",
    table(["t", "Phase", "Outbox lag", "Pending events", "Queue depth"], timeline(input, phases)),
    "",
    "## Outcomes",
    "",
    table(
      ["", "k6", "Replicas' counters", "Database"],
      [
        [
          "HTTP transactions processed",
          String(k6Count(summary, "tx_processed")),
          String(
            sumOf(server, "wager_transactions_total", { source: "http", status: "PROCESSED" }),
          ),
          String(input.database.http.processed),
        ],
        [
          "HTTP transactions rejected",
          `${k6Count(summary, "tx_rejected")} (${rejectionsByCode(summary)})`,
          String(
            sumOf(server, "wager_transactions_total", { source: "http", status: "REJECTED" }) +
              sumOf(server, "wager_transactions_total", { source: "http", status: "FAILED" }),
          ),
          String(input.database.http.rejected),
        ],
        [
          "HTTP transactions without a decision",
          `${k6Count(summary, "tx_in_doubt")} in doubt, ${k6Count(summary, "tx_not_applied")} not applied`,
          "n/a",
          "n/a",
        ],
        [
          "Idempotent replays over HTTP",
          String(k6Count(summary, "responses_replay")),
          String(
            sumOf(server, "wager_duplicates_total", { source: "http", type: "idempotent_replay" }),
          ),
          "n/a",
        ],
        ["BETs sent twice at once", String(k6Count(summary, "parallel_pairs")), "n/a", "n/a"],
        [
          "Transactions from the queue",
          `${queueSent} messages sent`,
          `${sumOf(server, "wager_transactions_total", { source: "sqs" })} decided (${labelled(
            server.filter((sample) => sample.labels.source === "sqs"),
            "wager_transactions_total",
            "status",
          )})`,
          `${input.database.queue} stored, ${input.database.inboxRows} inbox rows`,
        ],
        [
          "Redelivered messages absorbed by the inbox",
          "n/a",
          String(
            sumOf(server, "wager_duplicates_total", { source: "sqs", type: "duplicate_message" }),
          ),
          "n/a",
        ],
        [
          "Lock conflicts (WALLET_BUSY)",
          String(k6Count(summary, "responses_wallet_busy")),
          labelled(server, "wallet_lock_conflicts_total", "source"),
          "n/a",
        ],
        [
          "Dependency unavailable (503)",
          String(k6Count(summary, "responses_dependency_unavailable")),
          "n/a",
          "n/a",
        ],
        [
          "Answers lost (no response)",
          String(k6Count(summary, "responses_network_error")),
          "n/a",
          "n/a",
        ],
        ["Retries", "n/a", labelled(server, "wager_retries_total", "reason"), "n/a"],
        ["Events published", "n/a", String(sumOf(server, "outbox_events_published_total")), "n/a"],
      ],
    ),
    "",
    "## Processing time inside the replicas",
    "",
    "From `wager_processing_duration_seconds`, read from every replica at the end of each phase (bucket interpolation, so approximate): the time spent in the use case, waiting for a database connection included, but not the time a request waited before the use case started (in nginx or the replica's event loop). Next to k6's latency, the difference shows where a request waited.",
    "",
    table(
      ["Phase", "Source and outcome", "Count", "p50", "p95", "p99"],
      serverLatencyRows(input.phaseServer),
    ),
    "",
    "## Correctness",
    "",
    table(
      ["Check", "Result", "Detail"],
      input.checks.map((check) => [check.name, check.passed ? "pass" : "**FAIL**", check.detail]),
    ),
    "",
  ].join("\n");
}
