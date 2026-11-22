import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { FullJitterBackoff } from "../../domain/shared/backoff";
import type { Clock } from "../ports/clock";
import type {
  EventPublisher,
  PublicationFailure,
  PublicationReport,
} from "../ports/event-publisher";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface PublishOutboxCommand {
  readonly limit: number;
}

export interface PublishOutboxResult {
  /** Events claimed in this round. */
  readonly claimed: number;
  readonly published: number;
  /** Events that will be retried, with a bounded reason each. */
  readonly failures: readonly PublicationFailure[];
}

/**
 * Publishes one round of due events. It claims at most one event per wallet, the oldest
 * unpublished one (`FOR UPDATE SKIP LOCKED`), so concurrent publishers never hold two events
 * of the same wallet and each wallet's events leave in commit order. It holds the row locks
 * while it publishes, then marks each event published or schedules its next attempt with
 * full-jitter backoff: an event is never dropped.
 */
export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly publisher: EventPublisher,
    private readonly backoff: FullJitterBackoff,
  ) {}

  execute(command: PublishOutboxCommand): Promise<PublishOutboxResult> {
    return this.unitOfWork.run(async ({ outbox }) => {
      const due = await outbox.claimDue(this.clock.now(), command.limit);
      if (due.length === 0) {
        return { claimed: 0, published: 0, failures: [] };
      }
      const report = await this.publish(due);
      const reasons = new Map(
        report.failures.map((failure) => [failure.messageId, failure.reason]),
      );
      const now = this.clock.now();
      const failures: PublicationFailure[] = [];
      for (const message of due) {
        if (report.published.has(message.id)) {
          message.markPublished(now);
        } else {
          message.scheduleRetry(now, this.backoff);
          failures.push({
            messageId: message.id,
            reason: reasons.get(message.id) ?? "UNCONFIRMED",
          });
        }
        await outbox.save(message);
      }
      return { claimed: due.length, published: due.length - failures.length, failures };
    });
  }

  /** The port reports failures; anything it throws still means nothing was confirmed. */
  private async publish(messages: readonly OutboxMessage[]): Promise<PublicationReport> {
    try {
      return await this.publisher.publish(messages);
    } catch (error) {
      const reason = error instanceof Error ? error.name : "UNKNOWN";
      return {
        published: new Set(),
        failures: messages.map((message) => ({ messageId: message.id, reason })),
      };
    }
  }
}
