import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import type { Logger } from "pino";
import { Gauge, type Registry } from "prom-client";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { QueueUrls } from "../sqs/queue-urls";
import { SQS_CLIENT } from "../sqs/sqs-client";
import { withTimeout } from "../timeout";
import { LOGGER } from "./logger";
import { Metrics } from "./metrics";

interface OutboxBacklog {
  readonly pending: number;
  readonly lagSeconds: number;
  readonly overAttemptThreshold: number;
}

/** Each part is undefined when it could not be read: its gauges then keep their last value. */
interface SharedState {
  readonly outbox: OutboxBacklog | undefined;
  readonly pendingReferences: number | undefined;
  readonly deadLetters: number | undefined;
}

// One scrape reads every gauge; a snapshot this young is shared by all of them.
const SNAPSHOT_TTL_MS = 1000;

/**
 * Gauges of state shared by every replica, read from PostgreSQL and SQS at scrape time, so every
 * replica reports the same value: the outbox backlog, its lag (the age of the oldest unpublished
 * event), events over the attempt threshold, parked transactions and the dead-letter queue depth.
 * A failed read is logged and leaves the gauge as it was; it never fails the scrape.
 */
@Injectable()
export class SharedStateMetrics {
  private snapshot: { readonly takenAt: number; readonly state: Promise<SharedState> } | undefined;

  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly queueUrls: QueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    metrics: Metrics,
  ) {
    // Each gauge lives in the registry, which reads it at every scrape.
    const registry = metrics.registry;
    this.register(
      registry,
      "outbox_pending_events",
      "Events waiting in the outbox.",
      (state) => state.outbox?.pending,
    );
    this.register(
      registry,
      "outbox_lag_seconds",
      "Age of the oldest unpublished outbox event, 0 when none waits.",
      (state) => state.outbox?.lagSeconds,
    );
    this.register(
      registry,
      "outbox_events_over_attempt_threshold",
      "Unpublished events with at least OUTBOX_ALERT_ATTEMPTS failed attempts: the alert signal.",
      (state) => state.outbox?.overAttemptThreshold,
    );
    this.register(
      registry,
      "wager_pending_references",
      "Transactions parked in PENDING_REFERENCE.",
      (state) => state.pendingReferences,
    );
    this.register(
      registry,
      "sqs_dlq_messages",
      "Messages in the dead-letter queue of the inbound queue.",
      (state) => state.deadLetters,
    );
  }

  private register(
    registry: Registry,
    name: string,
    help: string,
    pick: (state: SharedState) => number | undefined,
  ): void {
    const current = () => this.current();
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        const value = pick(await current());
        if (value !== undefined) {
          this.set(value);
        }
      },
    });
  }

  private current(): Promise<SharedState> {
    // Monitoring time, not domain time: the Clock port is for the use cases.
    const now = performance.now();
    if (this.snapshot === undefined || now - this.snapshot.takenAt > SNAPSHOT_TTL_MS) {
      this.snapshot = { takenAt: now, state: this.read() };
    }
    return this.snapshot.state;
  }

  private async read(): Promise<SharedState> {
    const [outbox, pendingReferences, deadLetters] = await Promise.all([
      this.attempt("the outbox backlog", () => this.readOutbox()),
      this.attempt("the parked transactions", () => this.readPendingReferences()),
      this.attempt("the dead-letter queue depth", () => this.readDeadLetters()),
    ]);
    return { outbox, pendingReferences, deadLetters };
  }

  private async attempt<T>(what: string, read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await withTimeout(read(), this.config.healthCheckTimeoutMs);
    } catch (error) {
      this.logger.warn({ err: error }, `metrics could not read ${what}`);
      return undefined;
    }
  }

  private async readOutbox(): Promise<OutboxBacklog> {
    const [row] = await this.orm.em
      .fork()
      .getConnection()
      .execute(
        // occurred_at comes from each instance's clock and now() from the database's: skew
        // could make the age negative, so it is floored at zero.
        `select count(*)::int as pending,
           greatest(coalesce(extract(epoch from now() - min(occurred_at)), 0), 0)::float8 as lag,
           (count(*) filter (where attempts >= ?))::int as over
         from outbox_messages
         where published_at is null`,
        [this.config.outbox.alertAttempts],
      );
    return {
      pending: Number(row?.pending ?? 0),
      lagSeconds: Number(row?.lag ?? 0),
      overAttemptThreshold: Number(row?.over ?? 0),
    };
  }

  private async readPendingReferences(): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .getConnection()
      .execute(
        "select count(*)::int as parked from wager_transactions where status = 'PENDING_REFERENCE'",
      );
    return Number(row?.parked ?? 0);
  }

  private async readDeadLetters(): Promise<number> {
    const queueUrl = await this.queueUrls.resolve(this.config.sqs.queues.wagerTransactionsDlq);
    const { Attributes } = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
