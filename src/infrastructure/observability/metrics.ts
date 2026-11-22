import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/** Where a transaction entered: the HTTP API, the SQS consumer, or the reference retry worker. */
export type TransactionSource = "http" | "sqs" | "retry";

/**
 * Prometheus registry for this process. A dedicated registry, instead of prom-client's global
 * one, keeps metric registration explicit and safe to repeat.
 *
 * Label values must stay bounded: never amounts, and never raw ids or paths. The interfaces
 * record these from the use cases' results; the use cases themselves stay free of metrics.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration, by method, matched route and status code.",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transactions decided, by entry point, kind and status. Replays are counted as duplicates.",
    labelNames: ["source", "kind", "status"] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Duplicates detected: idempotent replays, redelivered messages and conflicting copies.",
    labelNames: ["source", "type"] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Wallet lock conflicts: lock timeouts, and busy wallets the retry worker skipped.",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Retries scheduled: messages after a failure, parked transactions, failed publications.",
    labelNames: ["operation", "reason"] as const,
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: "sqs_dead_lettered_messages_total",
    help: "Messages the consumer sent straight to the dead-letter queue, by reason.",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Time spent in the transaction use cases, by entry point and outcome.",
    labelNames: ["source", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly outboxPublished = new Counter({
    name: "outbox_events_published_total",
    help: "Events this process published from the outbox.",
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "reconciliation_divergences_total",
    help: "Reconciliations that found a stored balance different from its ledger.",
    registers: [this.registry],
  });

  readonly unexpectedErrors = new Counter({
    name: "unexpected_errors_total",
    help: "Errors that are bugs, by component.",
    labelNames: ["component"] as const,
    registers: [this.registry],
  });

  readonly consumerPaused = new Gauge({
    name: "sqs_consumer_paused",
    help: "1 while the consumer has stopped receiving because a dependency is unavailable.",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
