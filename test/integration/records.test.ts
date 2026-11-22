import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import { createMikroOrmOptions } from "../../src/infrastructure/mikro-orm/mikro-orm.config";
import {
  InboxMessageRecord,
  LedgerAccountRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../../src/infrastructure/mikro-orm/records";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase, testDatabaseConfig } from "../support/databases";
import { ledgerDiscrepancies } from "../support/ledger";

// The persistence records map the hand-written schema: amounts come back as decimal strings,
// timestamps as dates, the outbox sequence is assigned by the database, and a whole unit of work
// written through MikroORM satisfies the deferred checks at commit, in whatever order it flushes.

const uuid = (): string => Bun.randomUUIDv7();

describe("persistence records", () => {
  let database: TestDatabase | undefined;
  let orm: MikroORM | undefined;
  let sql: SQL | undefined;

  function ormInstance(): MikroORM {
    if (orm === undefined) {
      throw new Error("setup did not complete");
    }
    return orm;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    orm = await MikroORM.init(createMikroOrmOptions(testDatabaseConfig(database.url)));
    sql = new SQL(database.url);
  });

  afterAll(() =>
    cleanUp(
      () => sql?.close(),
      () => orm?.close(),
      () => database?.drop(),
    ),
  );

  // The final invariant of every integration test.
  afterEach(async () => {
    if (sql !== undefined) {
      expect(await ledgerDiscrepancies(sql)).toEqual([]);
    }
  });

  /** The FUNDING account of BRL, one per currency, created on first use. */
  let fundingAccountId: string | undefined;
  async function fundingAccount(): Promise<string> {
    if (fundingAccountId === undefined) {
      const id = uuid();
      await ormInstance()
        .em.fork()
        .transactional(async (em) => {
          em.create(LedgerAccountRecord, {
            id,
            type: "FUNDING",
            currency: "BRL",
            createdAt: new Date(),
          });
        });
      fundingAccountId = id;
    }
    return fundingAccountId;
  }

  /** Opens a wallet, with its OPENING credit above zero, the way the wallet use case will. */
  async function openWallet(balance: string) {
    const ids = {
      wallet: uuid(),
      funding: await fundingAccount(),
      opening: uuid(),
      entry: uuid(),
      event: uuid(),
      player: `player-${uuid()}`,
    };
    const now = new Date();
    const openedAtZero = /^0+(\.0+)?$/.test(balance);
    await ormInstance()
      .em.fork()
      .transactional(async (em) => {
        em.create(WalletRecord, {
          id: ids.wallet,
          playerId: ids.player,
          currency: "BRL",
          balance,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        em.create(LedgerAccountRecord, {
          id: ids.wallet,
          type: "PLAYER_WALLET",
          currency: "BRL",
          walletId: ids.wallet,
          createdAt: now,
        });
        if (openedAtZero) {
          return;
        }
        // The OPENING credit, its entry and its event, created after the wallet and children
        // before parents: the flush order does not matter, everything is checked at commit.
        em.create(OutboxMessageRecord, {
          id: ids.event,
          aggregateId: ids.wallet,
          orderingKey: ids.wallet,
          eventType: "WalletBalanceChanged",
          payload: {
            eventId: ids.event,
            data: { balanceAfter: { amount: balance, currency: "BRL" } },
          },
          occurredAt: now,
          nextAttemptAt: now,
        });
        em.create(LedgerEntryRecord, {
          id: ids.entry,
          transactionId: ids.opening,
          walletId: ids.wallet,
          walletVersion: 1,
          direction: "CREDIT",
          debitAccountId: ids.funding,
          creditAccountId: ids.wallet,
          amount: balance,
          currency: "BRL",
          balanceBefore: "0.00",
          balanceAfter: balance,
          createdAt: now,
        });
        em.create(WagerTransactionRecord, {
          id: ids.opening,
          walletId: ids.wallet,
          playerId: ids.player,
          kind: "OPENING",
          amount: balance,
          currency: "BRL",
          status: "PROCESSED",
          processedAt: now,
          observedBalance: balance,
          createdAt: now,
          updatedAt: now,
        });
      });
    return ids;
  }

  test("a unit of work round-trips: decimal strings, dates and database-assigned sequence", async () => {
    const ids = await openWallet("1000");
    const em = ormInstance().em.fork();

    const wallet = await em.findOneOrFail(WalletRecord, { id: ids.wallet });
    expect(wallet).toMatchObject({ playerId: ids.player, currency: "BRL", version: 1 });
    expect(wallet.balance).toBe("1000.00");
    expect(wallet.createdAt).toBeInstanceOf(Date);

    const opening = await em.findOneOrFail(WagerTransactionRecord, { id: ids.opening });
    expect(opening).toMatchObject({ kind: "OPENING", status: "PROCESSED", providerId: null });
    expect(opening.amount).toBe("1000.00");

    const entry = await em.findOneOrFail(LedgerEntryRecord, { id: ids.entry });
    expect(entry).toMatchObject({ balanceBefore: "0.00", balanceAfter: "1000.00" });

    const event = await em.findOneOrFail(OutboxMessageRecord, { id: ids.event });
    expect(event.payload).toEqual({
      eventId: ids.event,
      data: { balanceAfter: { amount: "1000", currency: "BRL" } },
    });
    expect(BigInt(event.sequenceNumber) > 0n).toBe(true);
    expect(event).toMatchObject({ attempts: 0, publishedAt: null });
  });

  test("the inbox is keyed by consumer and message id", async () => {
    const key = { consumerName: "wager-transactions", messageId: uuid() };
    const now = new Date();
    await ormInstance()
      .em.fork()
      .transactional(async (em) => {
        em.create(InboxMessageRecord, {
          ...key,
          payloadHash: "b".repeat(64),
          receivedAt: now,
          processedAt: now,
        });
      });

    const message = await ormInstance().em.fork().findOneOrFail(InboxMessageRecord, key);
    expect(message.processedAt).toBeInstanceOf(Date);
  });

  test("dirty checking updates a parked transaction, and the schema freezes it once decided", async () => {
    const ids = await openWallet("0");
    const id = uuid();
    const now = new Date();
    await ormInstance()
      .em.fork()
      .transactional(async (em) => {
        em.create(WagerTransactionRecord, {
          id,
          providerId: "provider-a",
          externalTransactionId: `refund-${id}`,
          idempotencyKey: `provider-a:refund-${id}`,
          payloadHash: "c".repeat(64),
          walletId: ids.wallet,
          playerId: ids.player,
          roundId: "round-1",
          gameId: "game-1",
          kind: "REFUND",
          amount: "25.00",
          currency: "BRL",
          referenceExternalTransactionId: "bet-late",
          status: "PENDING_REFERENCE",
          observedBalance: "0.00",
          referenceDeadline: new Date(now.getTime() + 15 * 60_000),
          nextAttemptAt: new Date(now.getTime() + 1000),
          createdAt: now,
          updatedAt: now,
        });
      });

    await ormInstance()
      .em.fork()
      .transactional(async (em) => {
        const parked = await em.findOneOrFail(WagerTransactionRecord, { id });
        parked.status = "REJECTED";
        parked.failureCode = "REFERENCE_NOT_FOUND";
        parked.nextAttemptAt = null;
        parked.updatedAt = new Date();
      });

    const decided = ormInstance().em.fork();
    const rejected = await decided.findOneOrFail(WagerTransactionRecord, { id });
    expect(rejected).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND" });
    rejected.updatedAt = new Date();
    await expect(decided.flush()).rejects.toMatchObject({
      code: "23000",
      constraint: "wager_transactions_terminal_state",
    });
  });
});
