import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { QueueNames } from "../../src/infrastructure/config/config";
import {
  type ProvisioningOptions,
  provisionQueues,
  type QueueUrls,
} from "../../src/infrastructure/sqs/queue-provisioning";
import { createSqsClient } from "../../src/infrastructure/sqs/sqs-client";
import { infra } from "./infra";

// Test queues end in a random suffix, which production names never have.
const TEST_QUEUE_PREFIXES = ["wager-transactions-", "wager-events-"];
const TEST_QUEUE_PATTERN = /-[0-9a-f]{8}\.fifo$/;
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface TestQueues {
  readonly names: QueueNames;
  readonly urls: QueueUrls;
  delete(): Promise<void>;
}

export function createTestSqsClient(): SQSClient {
  return createSqsClient({ region: infra.awsRegion, endpointUrl: infra.awsEndpointUrl });
}

/**
 * A queue set of its own for one test file, provisioned exactly like production, so tests never
 * see each other's messages.
 */
export async function createTestQueues(
  client: SQSClient,
  options: ProvisioningOptions = { maxReceiveCount: 5 },
): Promise<TestQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const names: QueueNames = {
    wagerTransactions: `wager-transactions-${suffix}.fifo`,
    wagerTransactionsDlq: `wager-transactions-dlq-${suffix}.fifo`,
    wagerEvents: `wager-events-${suffix}.fifo`,
  };
  const urls = await provisionQueues(client, names, options);
  return {
    names,
    urls,
    delete: async () => {
      const results = await Promise.allSettled(
        Object.values(urls).map((queueUrl) =>
          client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure !== undefined) {
        throw failure.reason;
      }
    },
  };
}

/** Deletes test queues older than an hour, left behind by interrupted runs. */
export async function deleteStaleTestQueues(client: SQSClient): Promise<void> {
  for (const prefix of TEST_QUEUE_PREFIXES) {
    let nextToken: string | undefined;
    do {
      const page = await client.send(
        new ListQueuesCommand({ QueueNamePrefix: prefix, MaxResults: 1000, NextToken: nextToken }),
      );
      for (const queueUrl of page.QueueUrls ?? []) {
        if (!TEST_QUEUE_PATTERN.test(queueUrl)) {
          continue;
        }
        const { Attributes } = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["CreatedTimestamp"],
          }),
        );
        const createdAtMs = Number(Attributes?.CreatedTimestamp) * 1000;
        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > STALE_AFTER_MS) {
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
  }
}
