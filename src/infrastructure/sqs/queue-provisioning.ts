import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  SetQueueAttributesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { QueueNames } from "../config/config";

export interface QueueUrls {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly wagerEvents: string;
}

export interface ProvisioningOptions {
  /** Receives of one message before SQS moves it to the dead-letter queue. */
  readonly maxReceiveCount: number;
}

const FOURTEEN_DAYS_IN_SECONDS = "1209600";

// Producers must send an explicit MessageDeduplicationId. Broker deduplication is only an
// optimization: the inbox table is what guarantees idempotency.
const FIFO_ATTRIBUTES = {
  FifoQueue: "true",
  ContentBasedDeduplication: "false",
  MessageRetentionPeriod: FOURTEEN_DAYS_IN_SECONDS,
};

/**
 * Creates the application queues, or reconciles their mutable attributes when they already
 * exist: the inbound FIFO queue with its dead-letter queue, and the FIFO queue that receives
 * the integration events published from the outbox. Safe to run repeatedly.
 */
export async function provisionQueues(
  client: SQSClient,
  names: QueueNames,
  options: ProvisioningOptions,
): Promise<QueueUrls> {
  const wagerTransactionsDlq = await ensureQueue(
    client,
    names.wagerTransactionsDlq,
    FIFO_ATTRIBUTES,
  );
  const deadLetterTargetArn = await queueArn(client, wagerTransactionsDlq);

  const wagerTransactions = await ensureQueue(client, names.wagerTransactions, {
    ...FIFO_ATTRIBUTES,
    VisibilityTimeout: "30",
    ReceiveMessageWaitTimeSeconds: "20",
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn,
      maxReceiveCount: options.maxReceiveCount,
    }),
  });
  const wagerEvents = await ensureQueue(client, names.wagerEvents, FIFO_ATTRIBUTES);

  return { wagerTransactions, wagerTransactionsDlq, wagerEvents };
}

async function ensureQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  try {
    const { QueueUrl } = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
    );
    return required(QueueUrl, `CreateQueue returned no URL for ${name}`);
  } catch (error) {
    // The queue exists with different attributes: reconcile those that can change.
    if (!(error instanceof QueueNameExists)) {
      throw error;
    }
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    const queueUrl = required(QueueUrl, `GetQueueUrl returned no URL for ${name}`);
    const { FifoQueue: _immutable, ...mutable } = attributes;
    await client.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: mutable }));
    return queueUrl;
  }
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
  );
  return required(Attributes?.QueueArn, `no QueueArn for ${queueUrl}`);
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
  return value;
}
