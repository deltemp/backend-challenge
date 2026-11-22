import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type {
  EventPublisher,
  PublicationFailure,
  PublicationReport,
} from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { SQS_MAX_BATCH_ENTRIES as BATCH_SIZE } from "./limits";

/**
 * Publishes outbox messages to the FIFO events queue. The body is the event envelope (JSON);
 * `MessageGroupId` is the wallet, so each wallet's events keep their order, and
 * `MessageDeduplicationId` is the event id, so a publication repeated after a crash is dropped
 * by SQS within its five-minute window (consumers deduplicate on `eventId` beyond it).
 *
 * `signal`, when given, aborts the calls in flight: the outbox worker passes its shutdown signal.
 * An aborted call counts as a failure, so its events are rescheduled, never lost.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly signal?: AbortSignal,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublicationReport> {
    const published = new Set<string>();
    const failures: PublicationFailure[] = [];
    for (let start = 0; start < messages.length; start += BATCH_SIZE) {
      const batch = messages.slice(start, start + BATCH_SIZE);
      try {
        const result = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: batch.map((message) => ({
              Id: message.id,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.orderingKey,
              MessageDeduplicationId: message.id,
              MessageAttributes: {
                eventType: { DataType: "String", StringValue: message.eventType },
              },
            })),
          }),
          { abortSignal: this.signal },
        );
        for (const entry of result.Successful ?? []) {
          if (entry.Id !== undefined) {
            published.add(entry.Id);
          }
        }
        for (const entry of result.Failed ?? []) {
          if (entry.Id !== undefined) {
            failures.push({ messageId: entry.Id, reason: entry.Code ?? "UNKNOWN" });
          }
        }
      } catch (error) {
        // The whole call failed (network, throttling, a missing queue): nothing was confirmed.
        const reason = error instanceof Error ? error.name : "UNKNOWN";
        for (const message of batch) {
          failures.push({ messageId: message.id, reason });
        }
      }
    }
    return { published, failures };
  }
}
