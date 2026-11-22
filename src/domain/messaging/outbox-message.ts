import type { IntegrationEvent } from "../events/integration-event";
import type { FullJitterBackoff } from "../shared/backoff";
import { InvariantViolationError } from "../shared/errors";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  /** The wallet: events with the same key are published in commit order. */
  readonly orderingKey: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date | undefined;
  readonly publishedAt: Date | undefined;
  /**
   * The W3C trace context headers of the transaction that wrote the event, when it was traced.
   * The outbox repository records them, and the publisher sends them with the event, so its
   * consumers continue that trace. Opaque to the domain.
   */
  readonly traceContext?: Readonly<Record<string, string>> | undefined;
}

/**
 * An integration event written in the same SQL transaction as the change it describes, and
 * published by a worker after the commit. A failed publication is rescheduled, never dropped:
 * a confirmed event must not be lost.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly orderingKey: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    readonly traceContext: Readonly<Record<string, string>> | undefined,
  ) {}

  /** Stores an event under its own id, due for publication right away. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.orderingKey,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  /** Rebuilds a persisted message without validating it again. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.orderingKey,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.traceContext,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} was already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Records a failed publication and schedules the next one with full-jitter backoff. */
  scheduleRetry(now: Date, backoff: FullJitterBackoff): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox message ${this.id} was already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(now, this._attempts - 1);
  }
}
