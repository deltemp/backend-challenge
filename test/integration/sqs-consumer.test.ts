import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { WagerTransactionView, WalletView } from "../../src/application/views";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { eventually } from "../support/eventually";
import { call, openWalletOverHttp } from "../support/http";
import { databaseUrlFor, infra } from "../support/infra";
import { ledgerDiscrepancies } from "../support/ledger";
import { drained, messagesIn, sendMessage, takeMessages, wagerMessage } from "../support/messaging";
import { metricValue } from "../support/metrics";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { balanceOf, deferred, transactionCommand } from "../support/use-cases";

// Short backoff and lock timeout, so retries happen within a test.
const CONSUMER_SETTINGS = {
  APP_ROLES: "api,consumer",
  DATABASE_LOCK_TIMEOUT_MS: "200",
  SQS_RETRY_BASE_MS: "100",
  SQS_RETRY_CAP_MS: "400",
  OUTAGE_BACKOFF_BASE_MS: "50",
  OUTAGE_BACKOFF_CAP_MS: "500",
};

interface Instance {
  readonly app: AppProcess;
  readonly sql: SQL;
  readonly queues: TestQueues;
}

/** A database, a queue set and an instance running the API and the consumer. */
function consumerInstance(maxReceiveCount = 5) {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let app: AppProcess | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs, { maxReceiveCount });
    sql = new SQL(database.url);
    app = await startApp({ ...appEnvironment(database, queues), ...CONSUMER_SETTINGS });
    await app.waitUntilReady();
  });

  afterAll(() =>
    cleanUp(
      () => app?.stop(),
      () => sql?.close(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    if (sql !== undefined) {
      expect(await ledgerDiscrepancies(sql)).toEqual([]);
    }
  });

  return {
    sqs,
    setup(): Instance {
      if (app === undefined || sql === undefined || queues === undefined) {
        throw new Error("setup did not complete");
      }
      return { app, sql, queues };
    },
  };
}

function lookup(baseUrl: string, providerId: string, externalTransactionId: string) {
  return eventually(`transaction ${externalTransactionId}`, async () => {
    const answer = await call(
      baseUrl,
      `/providers/${providerId}/wagering/transactions/${externalTransactionId}`,
    );
    return answer.status === 200 ? (answer.body as WagerTransactionView) : undefined;
  });
}

/** Holds the wallet's row lock from outside until `release` is called. */
async function lockWallet(sql: SQL, wallet: WalletView) {
  const locked = deferred();
  const released = deferred();
  const holder = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${wallet.id} for update`;
    locked.resolve();
    await released.promise;
  });
  await locked.promise;
  return async () => {
    released.resolve();
    await holder;
  };
}

// §10 and §13 integration: inbox and redelivery, retry and DLQ, the same use case as HTTP.
describe("SQS consumer", () => {
  const { sqs, setup } = consumerInstance();

  test("a message goes through the same use case, is recorded in the inbox and acknowledged after the commit", async () => {
    const { app, sql, queues } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "100.00");
    const command = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });
    const message = wagerMessage(command);

    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

    const transaction = await lookup(
      app.baseUrl,
      command.providerId,
      command.externalTransactionId,
    );
    expect(transaction).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
    });
    await drained(sqs, queues.urls.wagerTransactions);
    const inbox = await sql`
      select consumer_name as "consumerName", processed_at is not null as processed
      from inbox_messages where message_id = ${message.messageId}`;
    expect(inbox).toEqual([{ consumerName: "wager-transactions", processed: true }]);
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });

  test("a redelivered message does nothing again: one transaction, one ledger entry, one inbox row", async () => {
    const { app, sql, queues } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    const message = wagerMessage(command);
    const duplicates = () =>
      metricValue(app.baseUrl, "wager_duplicates_total", {
        source: "sqs",
        type: "duplicate_message",
      });
    const duplicatesBefore = await duplicates();

    // A new deduplication id each time, so SQS delivers both: the inbox is the guarantee.
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });
    await drained(sqs, queues.urls.wagerTransactions);

    const [counts] = await sql`
      select
        (select count(*)::int from wager_transactions
          where external_transaction_id = ${command.externalTransactionId}) as transactions,
        (select count(*)::int from ledger_entries where wallet_id = ${wallet.id}) as entries,
        (select count(*)::int from inbox_messages where message_id = ${message.messageId}) as inbox`;
    expect(counts).toEqual({ transactions: 1, entries: 2, inbox: 1 });
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
    expect(await duplicates()).toBe(duplicatesBefore + 1);
  });

  test("a business rejection is a final result: acknowledged, never dead-lettered", async () => {
    const { app, queues } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "10.00");
    const command = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    });

    await sendMessage(sqs, queues.urls.wagerTransactions, wagerMessage(command), {
      groupId: wallet.id,
    });

    expect(
      await lookup(app.baseUrl, command.providerId, command.externalTransactionId),
    ).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" });
    await drained(sqs, queues.urls.wagerTransactions);
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });

  test("a permanent error goes straight to the dead-letter queue, with its reason, and changes nothing", async () => {
    const { app, sql, queues } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    const processed = wagerMessage(command);
    await sendMessage(sqs, queues.urls.wagerTransactions, processed, { groupId: wallet.id });
    await drained(sqs, queues.urls.wagerTransactions);
    const refused: [unknown, string][] = [
      ['{"messageId": ', "MALFORMED_MESSAGE"],
      [
        { ...wagerMessage(transactionCommand(wallet, { kind: "BET" })), type: "WagerCancelled" },
        "UNKNOWN_MESSAGE_TYPE",
      ],
      [wagerMessage(transactionCommand(wallet, { kind: "OPENING" })), "VALIDATION_FAILED"],
      [
        wagerMessage(transactionCommand({ ...wallet, id: Bun.randomUUIDv7() }, { kind: "BET" })),
        "WALLET_NOT_FOUND",
      ],
      // The message id of the processed one, with another payload.
      [{ ...processed, data: { ...processed.data, roundId: "round-2" } }, "INBOX_CONFLICT"],
      // Its idempotency key, under another message, with another payload.
      [
        wagerMessage({ ...command, money: { amount: "11.00", currency: "BRL" } }),
        "IDEMPOTENCY_CONFLICT",
      ],
      // Its provider id, under another key.
      [
        wagerMessage({ ...command, idempotencyKey: "another-key" }),
        "EXTERNAL_TRANSACTION_CONFLICT",
      ],
    ];

    for (const [body] of refused) {
      await sendMessage(sqs, queues.urls.wagerTransactions, body, { groupId: wallet.id });
    }

    const deadLetters = await takeMessages(sqs, queues.urls.wagerTransactionsDlq, refused.length);
    expect(
      deadLetters.map((message) => message.MessageAttributes?.deadLetterReason?.StringValue).sort(),
    ).toEqual(refused.map(([, reason]) => reason).sort());
    expect(deadLetters.find((message) => message.Body === '{"messageId": ')).toBeDefined();
    await drained(sqs, queues.urls.wagerTransactions);
    const [stored] = await sql`
      select count(*)::int as transactions from wager_transactions where wallet_id = ${wallet.id}`;
    // The OPENING and the BET processed first: nothing else.
    expect(stored).toEqual({ transactions: 2 });
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
  });

  test("a transient error is retried with backoff until it succeeds", async () => {
    const { app, queues, sql } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    const retries = () =>
      metricValue(app.baseUrl, "wager_retries_total", {
        operation: "sqs_message",
        reason: "wallet_busy",
      });
    const retriesBefore = await retries();
    const release = await lockWallet(sql, wallet);

    try {
      await sendMessage(sqs, queues.urls.wagerTransactions, wagerMessage(command), {
        groupId: wallet.id,
      });
      // The consumer meets the lock, times out and reschedules the message.
      await eventually("a retry", async () =>
        (await retries()) > retriesBefore ? true : undefined,
      );
    } finally {
      await release();
    }

    expect(
      await lookup(app.baseUrl, command.providerId, command.externalTransactionId),
    ).toMatchObject({ status: "PROCESSED" });
    await drained(sqs, queues.urls.wagerTransactions);
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });
});

// Every receive counts against the redrive limit, so the consumer checks PostgreSQL first.
describe("SQS consumer while PostgreSQL is unreachable", () => {
  const sqs = createTestSqsClient();
  let queues: TestQueues | undefined;
  let app: AppProcess | undefined;

  beforeAll(async () => {
    queues = await createTestQueues(sqs);
    // A database that does not exist fails every connection, like one that is down.
    const missing = `wagering_missing_${crypto.randomUUID().slice(0, 8)}`;
    app = await startApp({
      DATABASE_URL: databaseUrlFor(missing),
      AWS_ENDPOINT_URL: infra.awsEndpointUrl,
      AWS_REGION: infra.awsRegion,
      SQS_WAGER_TRANSACTIONS_QUEUE: queues.names.wagerTransactions,
      SQS_WAGER_TRANSACTIONS_DLQ: queues.names.wagerTransactionsDlq,
      SQS_WAGER_EVENTS_QUEUE: queues.names.wagerEvents,
      ...CONSUMER_SETTINGS,
      APP_ROLES: "consumer",
    });
  });

  afterAll(() =>
    cleanUp(
      () => app?.stop(),
      () => queues?.delete(),
      () => sqs.destroy(),
    ),
  );

  test("an outage spends no receive: the consumer pauses before receiving, and the message waits untouched", async () => {
    if (app === undefined || queues === undefined) {
      throw new Error("setup did not complete");
    }
    const { baseUrl } = app;
    await sendMessage(sqs, queues.urls.wagerTransactions, { messageId: "msg-outage" });

    await eventually("the consumer paused", async () =>
      (await metricValue(baseUrl, "sqs_consumer_paused")) === 1 ? true : undefined,
    );
    const [message] = await takeMessages(sqs, queues.urls.wagerTransactions, 1);

    // This receive is the first: the paused consumer never took the message.
    expect(message?.Attributes?.ApproximateReceiveCount).toBe("1");
  });
});

describe("SQS consumer, once the receives run out", () => {
  const { sqs, setup } = consumerInstance(2);

  test("a message that keeps failing transiently is moved to the dead-letter queue by the redrive policy", async () => {
    const { app, queues, sql } = setup();
    const wallet = await openWalletOverHttp(app.baseUrl, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    const release = await lockWallet(sql, wallet);

    try {
      await sendMessage(sqs, queues.urls.wagerTransactions, wagerMessage(command), {
        groupId: wallet.id,
      });
      const [deadLetter] = await takeMessages(sqs, queues.urls.wagerTransactionsDlq, 1);

      // Moved by SQS after the second receive, not by the consumer: no reason attached.
      expect(deadLetter?.MessageAttributes?.deadLetterReason).toBeUndefined();
      expect(JSON.parse(deadLetter?.Body ?? "{}")).toMatchObject({
        data: { externalTransactionId: command.externalTransactionId },
      });
    } finally {
      await release();
    }
    await drained(sqs, queues.urls.wagerTransactions);
    const [stored] = await sql`
      select count(*)::int as transactions from wager_transactions
      where external_transaction_id = ${command.externalTransactionId}`;
    expect(stored).toEqual({ transactions: 0 });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });
});
