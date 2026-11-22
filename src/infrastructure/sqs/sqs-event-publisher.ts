import {
  type MessageAttributeValue,
  SendMessageBatchCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { type Link, SpanKind } from "@opentelemetry/api";
import type {
  EventPublisher,
  PublicationFailure,
  PublicationReport,
} from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import { inSpan, linkFrom, MESSAGING } from "../observability/tracing";
import { SQS_MAX_BATCH_ENTRIES as BATCH_SIZE } from "./limits";

// The W3C headers an event carries as message attributes, when its transaction was traced.
const TRACE_HEADERS = ["traceparent", "tracestate"] as const;

/**
 * Publishes outbox messages to the FIFO events queue. The body is the event envelope (JSON);
 * `MessageGroupId` is the wallet, so each wallet's events keep their order, and
 * `MessageDeduplicationId` is the event id, so a publication repeated after a crash is dropped
 * by SQS within its five-minute window (consumers deduplicate on `eventId` beyond it).
 *
 * Each event carries the trace context of the transaction that wrote it (`traceparent`,
 * `tracestate` attributes), so its consumers continue that trace. A publication is a producer
 * span of its own, linked to the trace of every event it sends.
 *
 * `signal`, when given, aborts the calls in flight: the outbox worker passes its shutdown signal.
 * An aborted call counts as a failure, so its events are rescheduled, never lost.
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly queueName: string;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly signal?: AbortSignal,
  ) {
    this.queueName = queueUrl.slice(queueUrl.lastIndexOf("/") + 1);
  }

  publish(messages: readonly OutboxMessage[]): Promise<PublicationReport> {
    const links = messages.flatMap((message): Link[] => {
      const link = linkFrom(message.traceContext ?? {});
      return link === undefined ? [] : [link];
    });
    return inSpan(
      `send ${this.queueName}`,
      {
        kind: SpanKind.PRODUCER,
        links,
        attributes: {
          [MESSAGING.system]: "aws_sqs",
          [MESSAGING.destination]: this.queueName,
          [MESSAGING.operation]: "send",
          [MESSAGING.batchSize]: messages.length,
        },
      },
      async (span) => {
        const report = await this.send(messages);
        span.setAttribute("wagering.publication.failures", report.failures.length);
        return report;
      },
    );
  }

  private async send(messages: readonly OutboxMessage[]): Promise<PublicationReport> {
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
              MessageAttributes: messageAttributes(message),
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

function messageAttributes(message: OutboxMessage): Record<string, MessageAttributeValue> {
  const attributes: Record<string, MessageAttributeValue> = {
    eventType: { DataType: "String", StringValue: message.eventType },
  };
  for (const header of TRACE_HEADERS) {
    const value = message.traceContext?.[header];
    if (value !== undefined && value !== "") {
      attributes[header] = { DataType: "String", StringValue: value };
    }
  }
  return attributes;
}
