import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { FullJitterBackoff } from "../../src/domain/shared/backoff";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/mikro-orm/unit-of-work";
import { uuidV7Ids } from "../../src/infrastructure/runtime";
import { SqsEventPublisher } from "../../src/infrastructure/sqs/sqs-event-publisher";
import { cleanUp } from "../support/cleanup";
import { ledgerDiscrepancies } from "../support/ledger";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import {
  openUseCaseHarness,
  openWallet,
  outboxRows,
  TestClock,
  type UseCaseHarness,
} from "../support/use-cases";

/**
 * Receives and deletes messages until `count` have arrived. FIFO groups release their next
 * message only once the previous one is deleted, so the order received is the order sent.
 */
async function receiveAll(client: SQSClient, queueUrl: string, count: number): Promise<Message[]> {
  const received: Message[] = [];
  for (let round = 0; round < 20 && received.length < count; round += 1) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
        MessageAttributeNames: ["All"],
      }),
    );
    received.push(...Messages);
    if (Messages.length > 0) {
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: Messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
          })),
        }),
      );
    }
  }
  return received;
}

// §11 and §13: the transactional outbox, published to SQS on LocalStack.
describe("PublishOutbox", () => {
  const sqs = createTestSqsClient();
  const clock = new TestClock();
  let queues: TestQueues | undefined;
  let harness: UseCaseHarness | undefined;

  function setup(): { harness: UseCaseHarness; queues: TestQueues } {
    if (harness === undefined || queues === undefined) {
      throw new Error("setup did not complete");
    }
    return { harness, queues };
  }

  beforeAll(async () => {
    queues = await createTestQueues(sqs);
    harness = await openUseCaseHarness({
      clock,
      random: () => 0.5,
      publisher: new SqsEventPublisher(sqs, queues.urls.wagerEvents),
    });
  });

  afterAll(() =>
    cleanUp(
      () => harness?.close(),
      () => queues?.delete(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    const { sql } = setup().harness;
    expect(await ledgerDiscrepancies(sql)).toEqual([]);
    // Leave nothing pending for the next test.
    await sql`update outbox_messages set published_at = now(), next_attempt_at = null
              where published_at is null`;
  });

  test("each round publishes at most one event per wallet, in commit order, to the FIFO queue", async () => {
    const { harness, queues } = setup();
    const { useCases, sql } = harness;
    const first = await openWallet(useCases, "100.00");
    const second = await openWallet(useCases, "50.00");

    const rounds = [];
    for (let round = 0; round < 3; round += 1) {
      rounds.push(await useCases.publishOutbox.execute({ limit: 10 }));
    }

    expect(rounds.map((round) => [round.claimed, round.published])).toEqual([
      [2, 2],
      [2, 2],
      [0, 0],
    ]);
    expect((await outboxRows(sql)).every((row) => row.published)).toBe(true);

    const messages = await receiveAll(sqs, queues.urls.wagerEvents, 4);
    expect(messages).toHaveLength(4);
    for (const wallet of [first, second]) {
      const group = messages.filter((message) => message.Attributes?.MessageGroupId === wallet.id);
      const envelopes = group.map((message) => JSON.parse(message.Body ?? "{}"));
      expect(envelopes.map((envelope) => envelope.eventType)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      for (const [index, message] of group.entries()) {
        expect(message.Attributes?.MessageDeduplicationId).toBe(envelopes[index].eventId);
        expect(message.MessageAttributes?.eventType?.StringValue).toBe(envelopes[index].eventType);
      }
    }
  });

  test("a failed publication is rescheduled with backoff, never dropped, and retried when due", async () => {
    const { harness, queues } = setup();
    const { useCases, sql } = harness;
    const wallet = await openWallet(useCases, "100.00");
    const broken = harness.variant({
      publisher: new SqsEventPublisher(sqs, `${queues.urls.wagerEvents}-missing`),
    });

    const failed = await broken.publishOutbox.execute({ limit: 10 });

    expect(failed).toMatchObject({ claimed: 1, published: 0 });
    expect(failed.failures).toHaveLength(1);
    const rows: { attempts: number; next: Date; published: boolean }[] = await sql`
      select attempts, next_attempt_at as next, published_at is not null as published
      from outbox_messages where ordering_key = ${wallet.id} order by sequence_number`;
    expect(rows[0]).toMatchObject({ attempts: 1, published: false });
    // First retry of base 1 s: half of 1 s.
    expect(rows[0]?.next.getTime()).toBe(clock.now().getTime() + 500);

    // Not due yet, and the wallet's second event waits behind the first.
    expect((await useCases.publishOutbox.execute({ limit: 10 })).claimed).toBe(0);

    clock.advance(500);
    expect(await useCases.publishOutbox.execute({ limit: 10 })).toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect(await useCases.publishOutbox.execute({ limit: 10 })).toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect((await outboxRows(sql, wallet.id)).map((row) => row.published)).toEqual([true, true]);
    await receiveAll(sqs, queues.urls.wagerEvents, 2);
  });

  test("marking an event another round already published changes nothing and fails nothing", async () => {
    const { harness } = setup();
    const { useCases, sql, orm } = harness;
    const wallet = await openWallet(useCases, "100.00");
    const rows: { id: string }[] = await sql`
      select id from outbox_messages where ordering_key = ${wallet.id}
      order by sequence_number limit 1`;
    const id = rows[0]?.id ?? "";
    await sql`update outbox_messages set published_at = now(), next_attempt_at = null
              where id = ${id}`;
    // A stale, still pending view of that event, as a slow round would hold it.
    const stale = OutboxMessage.rehydrate({
      id,
      aggregateId: wallet.id,
      orderingKey: wallet.id,
      eventType: "WagerTransactionProcessed",
      payload: {},
      occurredAt: clock.now(),
      attempts: 0,
      nextAttemptAt: clock.now(),
      publishedAt: undefined,
    });
    stale.scheduleRetry(
      clock.now(),
      FullJitterBackoff.create({ baseMs: 1000, capMs: 1000, random: () => 0.5 }),
    );

    await new MikroOrmUnitOfWork(orm, uuidV7Ids, clock).run(({ outbox }) => outbox.save(stale));

    const [after] = await sql`
      select attempts, published_at is not null as published from outbox_messages where id = ${id}`;
    expect(after).toEqual({ attempts: 0, published: true });
  });
});
