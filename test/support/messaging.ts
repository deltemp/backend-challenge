import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SubmitWagerTransactionCommand } from "../../src/application/use-cases/submit-wager-transaction";
import { eventually } from "./eventually";

export interface WagerMessage {
  readonly messageId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The §10 message of a command, as a provider would put it on the inbound queue. */
export function wagerMessage(
  command: SubmitWagerTransactionCommand,
  messageId = `msg-${Bun.randomUUIDv7()}`,
): WagerMessage {
  const { correlationId: _correlation, message: _message, ...data } = command;
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data,
  };
}

export interface SendOptions {
  /** Producers use the wallet; any group works, correctness does not depend on it. */
  readonly groupId?: string;
  /** A new one by default, so SQS never drops a deliberate duplicate. */
  readonly deduplicationId?: string;
}

/** Sends a body (an object is sent as JSON) to a FIFO queue. */
export async function sendMessage(
  client: SQSClient,
  queueUrl: string,
  body: unknown,
  options: SendOptions = {},
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: options.groupId ?? "test-group",
      MessageDeduplicationId: options.deduplicationId ?? Bun.randomUUIDv7(),
    }),
  );
}

/** Messages visible, in flight and delayed: zero once every message was acknowledged. */
export async function messagesIn(client: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesDelayed ?? 0)
  );
}

/** Waits until a queue holds nothing at all: every message was acknowledged or moved. */
export function drained(client: SQSClient, queueUrl: string, timeoutMs?: number): Promise<true> {
  return eventually(
    `queue ${queueUrl} to drain`,
    async () => ((await messagesIn(client, queueUrl)) === 0 ? true : undefined),
    timeoutMs,
  );
}

/**
 * Receives and deletes messages until `expected` of those matching `wanted` arrived, and returns
 * those, in arrival order. For the dead-letter and events queues, which no application process
 * consumes in tests.
 */
export async function takeMessages(
  client: SQSClient,
  queueUrl: string,
  expected: number,
  wanted: (message: Message) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<Message[]> {
  const taken: Message[] = [];
  await eventually(
    `${expected} messages on ${queueUrl}`,
    async () => {
      const { Messages } = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ["All"],
          MessageAttributeNames: ["All"],
        }),
      );
      for (const message of Messages ?? []) {
        if (wanted(message)) {
          taken.push(message);
        }
        await client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
      return taken.length >= expected ? true : undefined;
    },
    timeoutMs,
    0,
  );
  return taken;
}

/** The envelope an event message carries, as published from the outbox. */
export interface PublishedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export function eventOf(message: Message): PublishedEvent {
  return JSON.parse(message.Body ?? "{}") as PublishedEvent;
}
