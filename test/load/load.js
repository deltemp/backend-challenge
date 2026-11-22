// Load test of the wagering processor. Run it with `bun run test:load`: scripts/load-test.ts opens
// the wallets, writes the plan this script reads, samples the outbox and the queue, waits for
// both to drain, reconciles every wallet and compares these client-side counts with the database
// and the servers' counters.
//
// Phases run one after another, each with its own k6 scenario, so their numbers stay apart:
//   warmup: betting rounds over HTTP at the first step's rate;
//   queue: rounds sent to wager-transactions.fifo as §10 messages, at a constant rate, while the
//     system is still calm;
//   step_<rate> for each rate: an open model (constant arrival rate of betting rounds over HTTP),
//     so a slow server cannot slow the arrivals down and hide its latency;
//   hot_wallet: many virtual users betting without pause on a few wallets, to measure contention.
//
// Money is never a number here either: amounts are decimal strings from a fixed table.

import { sleep } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const PLAN_FILE = __ENV.LOAD_PLAN_FILE || "/results/plan.json";
const BASE_URL = __ENV.BASE_URL || "http://proxy";
const SQS_ENDPOINT = __ENV.SQS_ENDPOINT || "http://localstack:4566";

const plan = JSON.parse(open(PLAN_FILE)).plan;
const httpWallets = new SharedArray("http wallets", () => JSON.parse(open(PLAN_FILE)).wallets.http);
const queueWallets = new SharedArray(
  "queue wallets",
  () => JSON.parse(open(PLAN_FILE)).wallets.queue,
);
const hotWallets = new SharedArray("hot wallets", () => JSON.parse(open(PLAN_FILE)).wallets.hot);

// Each stake with the payout of a WIN: a WIN pays twice the bet.
const STAKES = [
  { bet: "1.00", win: "2.00" },
  { bet: "2.50", win: "5.00" },
  { bet: "5.00", win: "10.00" },
  { bet: "10.00", win: "20.00" },
  { bet: "20.00", win: "40.00" },
];

// A round is a BET settled by a WIN, a LOSS or a REFUND. Some WINs are rolled back, some
// settlements are resent on purpose (an idempotent replay), and some BETs are sent twice at once
// (an idempotency race). The expected balance change of a round is zero, so wallets last.
const MIX = {
  win: 0.45,
  loss: 0.45,
  rollbackOfWin: 0.05,
  replay: 0.05,
  parallelBet: 0.05,
};

const MAX_ATTEMPTS = 6;
// Under 500 the server decided (or refused the request); 5xx and no answer are errors.
const DECIDED_OR_REFUSED = http.expectedStatuses({ min: 200, max: 499 });

// Per answer.
const decided = new Counter("responses_decided");
const replays = new Counter("responses_replay");
const walletBusy = new Counter("responses_wallet_busy");
const unavailable = new Counter("responses_dependency_unavailable");
const serverErrors = new Counter("responses_server_error");
const networkErrors = new Counter("responses_network_error");
const unexpected = new Counter("responses_unexpected");
// Per transaction, once, by how it ended.
const processed = new Counter("tx_processed");
const rejected = new Counter("tx_rejected");
const pending = new Counter("tx_pending");
// No decision after every attempt: in doubt when an attempt may have committed (no answer, or a
// dependency lost mid-transaction); not applied when every attempt met a busy wallet, which
// rolls the transaction back.
const inDoubt = new Counter("tx_in_doubt");
const notApplied = new Counter("tx_not_applied");
// Transactions that met a 503 DEPENDENCY_UNAVAILABLE on some attempt: the servers' counters may
// miss one of them, stored by an attempt whose use case failed after the commit.
const dependencyLost = new Counter("tx_dependency_lost");
const settleTime = new Trend("settle_ms", true);
const parallelPairs = new Counter("parallel_pairs");
const parallelAnomalies = new Counter("parallel_anomalies");
const replayAnomalies = new Counter("replay_anomalies");
const queueSent = new Counter("queue_messages_sent");
// A send with no answer, or a 5xx, may have enqueued its message; a 4xx did not.
const queueSendUnknown = new Counter("queue_send_unknown");
const queueSendRefused = new Counter("queue_send_refused");

const FAILURE_CODES = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_WOULD_OVERDRAW",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_KIND_NOT_ALLOWED",
  "REFERENCE_NOT_PROCESSED",
  "REFERENCE_ALREADY_REVERSED",
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "WALLET_PLAYER_MISMATCH",
  "INTERNAL_ERROR",
];

function buildScenarios() {
  const scenarios = {};
  let startSeconds = 0;
  const arrivals = (rate, seconds, execName) => ({
    executor: "constant-arrival-rate",
    rate,
    timeUnit: "1s",
    duration: `${seconds}s`,
    startTime: `${startSeconds}s`,
    // A round takes a few requests; under saturation it takes longer and needs more users.
    preAllocatedVUs: Math.max(5, Math.ceil(rate / 2)),
    maxVUs: Math.max(20, rate * 3),
    // A round cut short with a request in flight would leave an outcome nobody counted.
    gracefulStop: "60s",
    exec: execName,
  });
  scenarios.warmup = arrivals(plan.steps[0], plan.warmupSeconds, "round");
  startSeconds += plan.warmupSeconds;
  scenarios.queue = arrivals(plan.queueRate, plan.queueSeconds, "queueRound");
  startSeconds += plan.queueSeconds;
  for (const rate of plan.steps) {
    scenarios[`step_${rate}`] = arrivals(rate, plan.stepSeconds, "round");
    startSeconds += plan.stepSeconds;
  }
  scenarios.hot_wallet = {
    executor: "constant-vus",
    vus: plan.hotVus,
    duration: `${plan.hotSeconds}s`,
    startTime: `${startSeconds}s`,
    gracefulStop: "60s",
    exec: "hotBet",
  };
  return scenarios;
}

// Thresholds on correctness only: latency is measured and analysed, not judged. The other
// entries never fail; they make k6 keep each phase's figures apart in the summary.
function buildThresholds(scenarioNames) {
  const thresholds = {
    responses_server_error: ["count==0"],
    responses_unexpected: ["count==0"],
    parallel_anomalies: ["count==0"],
    replay_anomalies: ["count==0"],
  };
  for (const name of scenarioNames) {
    thresholds[`http_req_duration{kind:submit,scenario:${name}}`] = ["max>=0"];
    thresholds[`http_reqs{kind:submit,scenario:${name}}`] = ["count>=0"];
    thresholds[`http_req_failed{kind:submit,scenario:${name}}`] = ["rate>=0"];
    thresholds[`iterations{scenario:${name}}`] = ["count>=0"];
    thresholds[`dropped_iterations{scenario:${name}}`] = ["count>=0"];
    thresholds[`settle_ms{scenario:${name}}`] = ["max>=0"];
    thresholds[`tx_processed{scenario:${name}}`] = ["count>=0"];
    thresholds[`tx_rejected{scenario:${name}}`] = ["count>=0"];
    thresholds[`responses_wallet_busy{scenario:${name}}`] = ["count>=0"];
    thresholds[`responses_dependency_unavailable{scenario:${name}}`] = ["count>=0"];
  }
  for (const code of FAILURE_CODES) {
    thresholds[`tx_rejected{code:${code}}`] = ["count>=0"];
  }
  thresholds[`http_req_duration{kind:sqs}`] = ["max>=0"];
  return thresholds;
}

const scenarios = buildScenarios();

export const options = {
  scenarios,
  thresholds: buildThresholds(Object.keys(scenarios)),
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
};

export function setup() {
  // Counters with a threshold must exist even when nothing increments them.
  for (const counter of [serverErrors, unexpected, parallelAnomalies, replayAnomalies]) {
    counter.add(0);
  }
  // scripts/load-test.ts aligns its samples on this line.
  console.log("LOAD_TEST_STARTED");
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function transaction(providerId, wallet, roundId, kind, amount, reference) {
  const externalTransactionId = `${plan.runId}-${kind.toLowerCase()}-${crypto.randomUUID()}`;
  const body = {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: "load-test",
    kind,
    money: { amount, currency: "BRL" },
  };
  if (reference !== undefined) {
    body.referenceExternalTransactionId = reference.body.externalTransactionId;
  }
  return { key: `${providerId}:${externalTransactionId}`, body };
}

function request(tx) {
  return {
    method: "POST",
    url: `${BASE_URL}/wagering/transactions`,
    body: JSON.stringify(tx.body),
    params: {
      headers: { "content-type": "application/json", "idempotency-key": tx.key },
      tags: { kind: "submit", tx: tx.body.kind },
      responseCallback: DECIDED_OR_REFUSED,
      timeout: "30s",
    },
  };
}

function send(tx) {
  const { url, body, params } = request(tx);
  return http.post(url, body, params);
}

function problemCode(response) {
  try {
    return response.json("code");
  } catch {
    return undefined;
  }
}

/**
 * Classifies one answer. The server decided (200, 202, 422: the decision), or the request may
 * be resent with the same key (503 or no answer: a delay, and whether this attempt may have
 * committed), or the answer is a bug or a request this script should never have sent (500, any
 * other status: the request failed).
 */
function classify(response) {
  if (response.status === 200 || response.status === 202 || response.status === 422) {
    decided.add(1);
    const decision = response.json();
    if (decision.idempotentReplay === true) {
      replays.add(1);
    }
    return { decision };
  }
  if (response.status === 0) {
    networkErrors.add(1);
    return { retryAfterSeconds: 1, mayHaveCommitted: true };
  }
  if (response.status === 503) {
    // A busy wallet is a lock timeout: the transaction was rolled back. An unavailable
    // dependency may have been lost while the transaction committed.
    const busy = problemCode(response) === "WALLET_BUSY";
    (busy ? walletBusy : unavailable).add(1);
    const retryAfter = Number(response.headers["Retry-After"]);
    return {
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1,
      mayHaveCommitted: !busy,
      dependencyLost: !busy,
    };
  }
  if (response.status >= 500) {
    serverErrors.add(1);
    console.error(`HTTP ${response.status}: ${response.body}`);
    return { failed: true };
  }
  unexpected.add(1, { status: String(response.status) });
  console.error(`unexpected HTTP ${response.status}: ${response.body}`);
  return { failed: true };
}

/**
 * Resends a transaction with its key until the server decides, as a provider would. Without a
 * decision, `inDoubt` says whether an attempt may have committed anyway; `dependencyLost`
 * whether an attempt met a dependency lost mid-transaction.
 */
function settle(tx, firstResponse) {
  let response = firstResponse ?? send(tx);
  let doubt = false;
  let lost = false;
  for (let attempt = 1; ; attempt += 1) {
    const outcome = classify(response);
    lost = lost || outcome.dependencyLost === true;
    if (outcome.decision !== undefined) {
      return { decision: outcome.decision, inDoubt: false, dependencyLost: lost };
    }
    doubt = doubt || outcome.mayHaveCommitted === true;
    if (outcome.failed === true || attempt >= MAX_ATTEMPTS) {
      return { decision: undefined, inDoubt: doubt, dependencyLost: lost };
    }
    sleep(outcome.retryAfterSeconds);
    response = send(tx);
  }
}

/**
 * Counts a transaction once, by how it ended. Each transaction left in doubt is logged with its
 * key, so scripts/load-test.ts looks it up in the database instead of guessing.
 */
function record(tx, { decision, inDoubt: doubt, dependencyLost: lost }, startedAt) {
  if (lost) {
    dependencyLost.add(1);
  }
  if (decision === undefined) {
    if (doubt) {
      inDoubt.add(1);
      console.log(`LOAD_IN_DOUBT ${tx.key}`);
    } else {
      notApplied.add(1);
    }
    return;
  }
  settleTime.add(Date.now() - startedAt);
  if (decision.status === "PROCESSED") {
    processed.add(1);
  } else if (decision.status === "PENDING_REFERENCE") {
    pending.add(1);
  } else {
    rejected.add(1, { code: decision.failureCode ?? "NONE" });
  }
}

function submit(tx) {
  const startedAt = Date.now();
  const outcome = settle(tx);
  record(tx, outcome, startedAt);
  return outcome.decision;
}

/**
 * Two answers carry the same stored outcome: the same transaction, status, failure code and
 * balance (strings compared as such). A replay answers from the snapshot stored with the
 * transaction, never from the current balance.
 */
function sameOutcome(a, b) {
  return (
    a.transactionId === b.transactionId &&
    a.status === b.status &&
    (a.failureCode ?? null) === (b.failureCode ?? null) &&
    a.balance?.amount === b.balance?.amount &&
    a.balance?.currency === b.balance?.currency
  );
}

/** The same BET twice at once: exactly one may be processed, the other is its replay. */
function submitTwice(tx) {
  parallelPairs.add(1);
  const startedAt = Date.now();
  const [first, second] = http.batch([request(tx), request(tx)]);
  const a = settle(tx, first);
  const b = settle(tx, second);
  if (a.decision !== undefined && b.decision !== undefined) {
    const decisions = [a.decision, b.decision];
    const firstTime = decisions.filter((decision) => decision.idempotentReplay === false).length;
    if (!sameOutcome(a.decision, b.decision) || firstTime > 1) {
      parallelAnomalies.add(1);
      console.error(`idempotency race anomaly: ${JSON.stringify(decisions)}`);
    }
  }
  const outcome = {
    decision: a.decision ?? b.decision,
    inDoubt: a.inDoubt || b.inDoubt,
    dependencyLost: a.dependencyLost || b.dependencyLost,
  };
  record(tx, outcome, startedAt);
  return outcome.decision;
}

/** Resends a decided transaction on purpose: the answer must be its stored outcome. */
function replay(tx, original) {
  const { decision } = settle(tx);
  if (
    decision !== undefined &&
    (decision.idempotentReplay !== true || !sameOutcome(original, decision))
  ) {
    replayAnomalies.add(1);
    console.error(`replay anomaly: ${JSON.stringify({ original, decision })}`);
  }
}

export function round() {
  const wallet = pick(httpWallets);
  const stake = pick(STAKES);
  const roundId = `round-${crypto.randomUUID()}`;
  const tx = (kind, amount, reference) =>
    transaction(plan.providerId, wallet, roundId, kind, amount, reference);
  const bet = tx("BET", stake.bet);
  const placed = Math.random() < MIX.parallelBet ? submitTwice(bet) : submit(bet);
  if (placed?.status !== "PROCESSED") {
    return;
  }
  const roll = Math.random();
  const settlement =
    roll < MIX.win
      ? tx("WIN", stake.win, bet)
      : roll < MIX.win + MIX.loss
        ? tx("LOSS", "0.00", bet)
        : tx("REFUND", stake.bet, bet);
  const settled = submit(settlement);
  if (settled === undefined) {
    return;
  }
  if (Math.random() < MIX.replay) {
    replay(settlement, settled);
  }
  if (
    settled.status === "PROCESSED" &&
    settlement.body.kind === "WIN" &&
    Math.random() < MIX.rollbackOfWin
  ) {
    submit(tx("ROLLBACK", stake.win, settlement));
  }
}

export function hotBet() {
  const wallet = hotWallets[(exec.vu.idInTest - 1) % hotWallets.length];
  submit(transaction(plan.providerId, wallet, `round-${crypto.randomUUID()}`, "BET", "1.00"));
}

/**
 * Sends one transaction as a §10 message, with the wallet as its group. LocalStack accepts
 * unsigned calls; against AWS this would need SigV4. The message id carries the send time, so
 * scripts/load-test.ts measures each message's wait from the inbox afterwards, without polling.
 */
function enqueue(tx) {
  const sentAt = Date.now();
  const messageId = `${plan.runId}-${sentAt}-${crypto.randomUUID()}`;
  const message = {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date(sentAt).toISOString(),
    data: { ...tx.body, idempotencyKey: tx.key },
  };
  const response = http.post(
    `${SQS_ENDPOINT}/`,
    JSON.stringify({
      QueueUrl: plan.queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: tx.body.walletId,
      MessageDeduplicationId: messageId,
    }),
    {
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonSQS.SendMessage",
      },
      tags: { kind: "sqs" },
      timeout: "30s",
    },
  );
  if (response.status === 200) {
    queueSent.add(1);
    return true;
  }
  if (response.status === 0 || response.status >= 500) {
    // It may have been enqueued: scripts/load-test.ts looks for its inbox row.
    queueSendUnknown.add(1);
    console.log(`LOAD_SEND_UNKNOWN ${messageId}`);
  } else {
    queueSendRefused.add(1);
  }
  console.error(`SendMessage answered ${response.status}: ${response.body}`);
  return false;
}

export function queueRound() {
  const wallet = pick(queueWallets);
  const stake = pick(STAKES);
  const roundId = `round-${crypto.randomUUID()}`;
  const tx = (kind, amount, reference) =>
    transaction(plan.queueProviderId, wallet, roundId, kind, amount, reference);
  const bet = tx("BET", stake.bet);
  if (!enqueue(bet)) {
    return;
  }
  // Same group, so the consumer processes the settlement after its BET.
  enqueue(Math.random() < 0.5 ? tx("WIN", stake.win, bet) : tx("LOSS", "0.00", bet));
}

export function handleSummary(data) {
  return {
    "/results/k6-summary.json": JSON.stringify(data),
    stdout: "\nk6 finished; scripts/load-test.ts writes the report.\n",
  };
}
