import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { PublishOutboxResult } from "../../src/application/use-cases/publish-outbox";
import { SqsEventPublisher } from "../../src/infrastructure/sqs/sqs-event-publisher";
import { cleanUp } from "../support/cleanup";
import { ledgerDiscrepancies } from "../support/ledger";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import {
  balanceOf,
  openUseCaseHarness,
  openWallet,
  TestClock,
  transactionCommand,
  type UseCaseHarness,
} from "../support/use-cases";

// §13 concurrency, at the level of the use cases: every call runs its own SQL transaction on its
// own pooled connection, so PostgreSQL sees truly concurrent transactions. The multi-process
// scenarios (three instances, a worker killed between commit and ack, a restart) run real
// processes and come with the HTTP API and the consumer.

describe("concurrent transactions on wallets", () => {
  const clock = new TestClock();
  let harness: UseCaseHarness | undefined;

  function setup(): UseCaseHarness {
    if (harness === undefined) {
      throw new Error("setup did not complete");
    }
    return harness;
  }

  beforeAll(async () => {
    harness = await openUseCaseHarness({ database: { poolMax: 20 }, clock });
  });

  afterAll(() => harness?.close());

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  async function betEntries(walletId: string): Promise<number> {
    const [row] = await setup().sql`
      select count(*)::int as entries from ledger_entries e
      join wager_transactions t on t.id = e.transaction_id
      where e.wallet_id = ${walletId} and t.kind = 'BET'`;
    return Number(row?.entries);
  }

  test("§8: two concurrent 80.00 bets against 100.00, exactly one is debited", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = () =>
      useCases.submitWagerTransaction.execute(
        transactionCommand(wallet, { kind: "BET", money: { amount: "80.00", currency: "BRL" } }),
      );

    const results = await Promise.all([bet(), bet()]);

    const statuses: string[] = results.map((result) => result.transaction.status).sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const rejected = results.find((result) => result.transaction.status === "REJECTED");
    expect(rejected?.transaction).toMatchObject({
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "20.00", currency: "BRL" },
    });
    expect(await balanceOf(sql, wallet.id)).toBe("20.00");
    expect(await betEntries(wallet.id)).toBe(1);
  });

  test("the same bet sent 50 times in parallel is debited once; the rest are replays", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCases.submitWagerTransaction.execute(bet)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transaction.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.transaction.balance?.amount))).toEqual(
      new Set(["90.00"]),
    );
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
    expect(await betEntries(wallet.id)).toBe(1);
  });

  test("distinct wallets are processed in parallel, each one consistent", async () => {
    const { useCases, sql } = setup();
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWallet(useCases, "100.00")),
    );

    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          useCases.submitWagerTransaction.execute(transactionCommand(wallet, { kind: "BET" })),
        ),
      ),
    );

    expect(results.every((result) => result.transaction.status === "PROCESSED")).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(sql, wallet.id)).toBe("50.00");
      expect(await betEntries(wallet.id)).toBe(5);
    }
  });

  test("a REFUND delivered before its BET, racing the BET and the retry worker, applies once", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const betId = `bet-${wallet.id}`;
    const refund = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, {
        kind: "REFUND",
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: betId,
      }),
    );
    clock.advance(1000);
    const reprocess = () =>
      useCases.reprocessPendingReference.execute({
        transactionId: refund.transaction.id,
        correlationId: "retry-worker",
      });

    await Promise.all([
      useCases.submitWagerTransaction.execute(
        transactionCommand(wallet, {
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
          externalTransactionId: betId,
        }),
      ),
      reprocess(),
      reprocess(),
      reprocess(),
    ]);
    // Whatever the interleaving, one more attempt once everything is due settles it.
    clock.advance(120_000);
    await reprocess();

    const [refundRow] = await sql`
      select status from wager_transactions where id = ${refund.transaction.id}`;
    expect(refundRow).toEqual({ status: "PROCESSED" });
    const [credits] = await sql`
      select count(*)::int as entries from ledger_entries
      where transaction_id = ${refund.transaction.id}`;
    expect(credits).toEqual({ entries: 1 });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });
});

async function receiveAll(client: SQSClient, queueUrl: string, count: number): Promise<Message[]> {
  const received: Message[] = [];
  for (let round = 0; round < 60 && received.length < count; round += 1) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId", "MessageDeduplicationId"],
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

describe("two publishers over the same outbox", () => {
  const sqs = createTestSqsClient();
  let queues: TestQueues | undefined;
  let harness: UseCaseHarness | undefined;

  beforeAll(async () => {
    queues = await createTestQueues(sqs);
    harness = await openUseCaseHarness({
      database: { poolMax: 10 },
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

  test("publish every event exactly once, each wallet's events in commit order", async () => {
    if (harness === undefined || queues === undefined) {
      throw new Error("setup did not complete");
    }
    const { useCases, sql } = harness;
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () => openWallet(useCases, "100.00")),
    );
    for (const wallet of wallets) {
      await useCases.submitWagerTransaction.execute(transactionCommand(wallet, { kind: "BET" }));
    }
    // 8 wallets × (OPENING: 2 events + BET: 2 events).
    const expected: { id: string; orderingKey: string }[] = await sql`
      select id, ordering_key as "orderingKey" from outbox_messages order by sequence_number`;
    expect(expected).toHaveLength(32);

    const rounds: PublishOutboxResult[] = [];
    const publisher = async () => {
      for (;;) {
        const round = await useCases.publishOutbox.execute({ limit: 3 });
        rounds.push(round);
        if (round.claimed === 0) {
          return;
        }
      }
    };
    await Promise.all([publisher(), publisher()]);
    // A round can find nothing while the other publisher holds every head: drain what is left.
    await publisher();

    expect(rounds.reduce((total, round) => total + round.published, 0)).toBe(32);
    expect(rounds.flatMap((round) => round.failures)).toEqual([]);
    const [pending] = await sql`
      select count(*)::int as pending from outbox_messages where published_at is null`;
    expect(pending).toEqual({ pending: 0 });

    const messages = await receiveAll(sqs, queues.urls.wagerEvents, 32);
    expect(
      new Set(messages.map((message) => message.Attributes?.MessageDeduplicationId)).size,
    ).toBe(32);
    for (const wallet of wallets) {
      const sent = messages
        .filter((message) => message.Attributes?.MessageGroupId === wallet.id)
        .map((message) => message.Attributes?.MessageDeduplicationId);
      const committed = expected
        .filter((row) => row.orderingKey === wallet.id)
        .map((row) => row.id);
      expect(sent).toEqual(committed);
    }
    expect(await ledgerDiscrepancies(sql)).toEqual([]);
  });
});
