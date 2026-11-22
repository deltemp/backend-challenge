import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { WagerTransactionView } from "../../src/application/views";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { eventually } from "../support/eventually";
import { call, openWalletOverHttp, submitOverHttp } from "../support/http";
import { ledgerDiscrepancies } from "../support/ledger";
import { eventOf, takeMessages } from "../support/messaging";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { balanceOf, transactionCommand } from "../support/use-cases";

const REFERENCE_TTL_MS = 3000;

// §11 and §7.1 over a real process: the outbox publisher and the reference retry worker, with
// short pacing so a test sees several rounds.
describe("background workers", () => {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let app: AppProcess | undefined;

  function setup(): { readonly baseUrl: string; readonly sql: SQL; readonly queues: TestQueues } {
    if (app === undefined || sql === undefined || queues === undefined) {
      throw new Error("setup did not complete");
    }
    return { baseUrl: app.baseUrl, sql, queues };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    sql = new SQL(database.url);
    app = await startApp({
      ...appEnvironment(database, queues),
      APP_ROLES: "api,outbox,retry",
      OUTBOX_POLL_INTERVAL_MS: "50",
      REFERENCE_RETRY_POLL_INTERVAL_MS: "50",
      REFERENCE_RETRY_BASE_MS: "50",
      REFERENCE_RETRY_CAP_MS: "200",
      REFERENCE_TTL_MS: String(REFERENCE_TTL_MS),
    });
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
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  function transaction(baseUrl: string, transactionId: string, status: string) {
    return eventually(`transaction ${transactionId} ${status}`, async () => {
      const answer = await call(baseUrl, `/wagering/transactions/${transactionId}`);
      const found = answer.body as WagerTransactionView;
      return found.status === status ? found : undefined;
    });
  }

  test("events reach wager-events.fifo after the commit, each wallet's in commit order", async () => {
    const { baseUrl, sql, queues } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    await submitOverHttp(baseUrl, transactionCommand(wallet, { kind: "BET" }));
    await submitOverHttp(baseUrl, transactionCommand(wallet, { kind: "WIN" }));

    const messages = await takeMessages(
      sqs,
      queues.urls.wagerEvents,
      6,
      (message) => message.Attributes?.MessageGroupId === wallet.id,
    );

    const events = messages.map(eventOf);
    expect(events.map((event) => event.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(events.map((event) => event.data.walletVersion).filter(Boolean)).toEqual([1, 2, 3]);
    for (const message of messages) {
      expect(message.Attributes?.MessageDeduplicationId).toBe(eventOf(message).eventId);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(eventOf(message).eventType);
    }
    await eventually("every event marked published", async () => {
      const [row] = await sql`
        select count(*)::int as pending from outbox_messages
        where ordering_key = ${wallet.id} and published_at is null`;
      return row?.pending === 0 ? true : undefined;
    });
  });

  test("a reversal that arrived before its BET is applied by the retry worker once the BET arrives", async () => {
    const { baseUrl, sql } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const money = { amount: "25.00", currency: "BRL" };
    const refund = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, { kind: "REFUND", money, referenceExternalTransactionId: betId }),
    );
    expect(refund.status).toBe(202);
    const { transactionId } = refund.body as { transactionId: string };

    const bet = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, { kind: "BET", money, externalTransactionId: betId }),
    );

    expect(bet.status).toBe(200);
    expect(await transaction(baseUrl, transactionId, "PROCESSED")).toMatchObject({
      balance: { amount: "100.00", currency: "BRL" },
    });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });

  test("a parked reversal whose reference never arrives is rejected at its deadline, and its event is published", async () => {
    const { baseUrl, queues } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const refund = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, {
        kind: "REFUND",
        referenceExternalTransactionId: `bet-${Bun.randomUUIDv7()}`,
      }),
    );
    const { transactionId } = refund.body as { transactionId: string };

    const rejected = await transaction(baseUrl, transactionId, "REJECTED");

    expect(rejected).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND" });
    const [event] = await takeMessages(
      sqs,
      queues.urls.wagerEvents,
      1,
      (message) =>
        eventOf(message).aggregateId === transactionId &&
        eventOf(message).eventType === "WagerTransactionRejected",
    );
    expect(event).toBeDefined();
  });
});
