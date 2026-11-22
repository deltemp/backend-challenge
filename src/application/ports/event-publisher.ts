import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface PublicationFailure {
  readonly messageId: string;
  /** A short, bounded reason (an SQS error code or an error name), safe to log and count. */
  readonly reason: string;
}

export interface PublicationReport {
  /** Ids of the outbox messages the broker accepted. */
  readonly published: ReadonlySet<string>;
  readonly failures: readonly PublicationFailure[];
}

/**
 * Publishes integration events to the events queue, at least once, ordered by `orderingKey`
 * and deduplicated by event id. Reports a message it could not publish instead of throwing.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublicationReport>;
}
