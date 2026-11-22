import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { provisionQueues } from "../../src/infrastructure/sqs/queue-provisioning";
import { cleanUp } from "../support/cleanup";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";

async function attributesOf(client: SQSClient, queueUrl: string): Promise<Record<string, string>> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["All"] }),
  );
  return Attributes ?? {};
}

function redrivePolicyOf(attributes: Record<string, string>) {
  const policy = JSON.parse(attributes.RedrivePolicy ?? "{}") as Record<string, unknown>;
  return {
    deadLetterTargetArn: policy.deadLetterTargetArn,
    maxReceiveCount: Number(policy.maxReceiveCount),
  };
}

describe("queue provisioning", () => {
  const sqs = createTestSqsClient();
  let queues: TestQueues;

  beforeAll(async () => {
    queues = await createTestQueues(sqs, { maxReceiveCount: 5 });
  });

  afterAll(() =>
    cleanUp(
      () => queues?.delete(),
      () => sqs.destroy(),
    ),
  );

  test("creates the inbound FIFO queue with a dead-letter redrive after 5 receives", async () => {
    const inbound = await attributesOf(sqs, queues.urls.wagerTransactions);
    const deadLetter = await attributesOf(sqs, queues.urls.wagerTransactionsDlq);

    expect(inbound.FifoQueue).toBe("true");
    expect(inbound.ContentBasedDeduplication).toBe("false");
    expect(redrivePolicyOf(inbound)).toEqual({
      deadLetterTargetArn: deadLetter.QueueArn,
      maxReceiveCount: 5,
    });
  });

  test("creates the dead-letter and event queues as FIFO queues without a redrive", async () => {
    for (const queueUrl of [queues.urls.wagerTransactionsDlq, queues.urls.wagerEvents]) {
      const attributes = await attributesOf(sqs, queueUrl);

      expect(attributes.FifoQueue).toBe("true");
      expect(attributes.ContentBasedDeduplication).toBe("false");
      expect(attributes.RedrivePolicy).toBeUndefined();
    }
  });

  test("is idempotent", async () => {
    const again = await provisionQueues(sqs, queues.names, { maxReceiveCount: 5 });

    expect(again).toEqual(queues.urls);
  });

  test("reconciles the redrive policy of a queue that already exists", async () => {
    await provisionQueues(sqs, queues.names, { maxReceiveCount: 3 });

    const inbound = await attributesOf(sqs, queues.urls.wagerTransactions);
    expect(redrivePolicyOf(inbound).maxReceiveCount).toBe(3);
  });
});
