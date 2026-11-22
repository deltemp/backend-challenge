import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  DuplicateKeyError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidRequestError,
  WalletBusyError,
  WalletNotFoundError,
} from "../../src/application/errors";
import type {
  Repositories,
  WagerTransactionRepository,
} from "../../src/application/ports/repositories";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import type { SubmitWagerTransactionCommand } from "../../src/application/use-cases/submit-wager-transaction";
import { InvalidWagerTransactionError } from "../../src/domain/shared/errors";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { cleanUp } from "../support/cleanup";
import { ledgerDiscrepancies } from "../support/ledger";
import {
  balanceOf,
  deferred,
  openUseCaseHarness,
  openWallet,
  outboxRows,
  transactionCommand,
  type UseCaseHarness,
} from "../support/use-cases";

// §13 integration: atomicity between wallet, ledger, inbox and outbox; inbox and redelivery.
describe("SubmitWagerTransaction", () => {
  let harness: UseCaseHarness | undefined;

  function setup(): UseCaseHarness {
    if (harness === undefined) {
      throw new Error("setup did not complete");
    }
    return harness;
  }

  beforeAll(async () => {
    harness = await openUseCaseHarness();
  });

  afterAll(() => harness?.close());

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  async function rowCounts(walletId: string) {
    const [counts] = await setup().sql`
      select
        (select count(*)::int from wager_transactions where wallet_id = ${walletId}) as transactions,
        (select count(*)::int from ledger_entries where wallet_id = ${walletId}) as entries,
        (select count(*)::int from outbox_messages where ordering_key = ${walletId}) as events`;
    return counts;
  }

  test("a BET debits the wallet, with its ledger entry and its events, atomically", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");

    const result = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", money: { amount: "30.00", currency: "BRL" } }),
    );

    expect(result).toMatchObject({ idempotentReplay: false, duplicateMessage: false });
    expect(result.transaction).toMatchObject({
      kind: "BET",
      status: "PROCESSED",
      balance: { amount: "70.00", currency: "BRL" },
      failureCode: null,
    });
    expect(await balanceOf(sql, wallet.id)).toBe("70.00");
    expect((await outboxRows(sql, wallet.id)).map((row) => row.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("the same request again is a replay of the stored outcome, not of the current balance", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "30.00", currency: "BRL" },
    });
    const first = await useCases.submitWagerTransaction.execute(bet);
    await useCases.submitWagerTransaction.execute(transactionCommand(wallet, { kind: "BET" }));
    const before = await rowCounts(wallet.id);

    const replay = await useCases.submitWagerTransaction.execute(bet);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.transaction.balance).toEqual({ amount: "70.00", currency: "BRL" });
    expect(await balanceOf(sql, wallet.id)).toBe("60.00");
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test("the same key with a divergent payload is a conflict, never a replay", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = transactionCommand(wallet, { kind: "BET" });
    await useCases.submitWagerTransaction.execute(bet);
    const before = await rowCounts(wallet.id);

    await expect(
      useCases.submitWagerTransaction.execute({
        ...bet,
        money: { amount: "10.01", currency: "BRL" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await rowCounts(wallet.id)).toEqual(before);
  });

  test("a provider's transaction id under another key is a conflict", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = transactionCommand(wallet, { kind: "BET" });
    await useCases.submitWagerTransaction.execute(bet);

    await expect(
      useCases.submitWagerTransaction.execute({ ...bet, idempotencyKey: "another-key" }),
    ).rejects.toBeInstanceOf(ExternalTransactionConflictError);
  });

  test("an unknown wallet is a contract error: nothing is stored, the key is not used up", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const command = transactionCommand(wallet, { kind: "BET", walletId: Bun.randomUUIDv7() });

    await expect(useCases.submitWagerTransaction.execute(command)).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    const [row] = await sql`
      select count(*)::int as stored from wager_transactions
      where idempotency_key = ${command.idempotencyKey}`;
    expect(row).toEqual({ stored: 0 });
  });

  test("a wallet of another player is a stored rejection that discloses no balance", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");

    const result = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", playerId: "someone-else" }),
    );

    expect(result.transaction).toMatchObject({
      status: "REJECTED",
      failureCode: "WALLET_PLAYER_MISMATCH",
      balance: null,
    });
    expect((await outboxRows(sql, wallet.id)).at(-1)?.eventType).toBe("WagerTransactionRejected");
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });

  test("a BET beyond the balance is rejected with the balance it saw, and replays so", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "20.00");
    const bet = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "20.01", currency: "BRL" },
    });

    const result = await useCases.submitWagerTransaction.execute(bet);
    const replay = await useCases.submitWagerTransaction.execute(bet);

    expect(result.transaction).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "20.00", currency: "BRL" },
    });
    expect(replay).toEqual({ ...result, idempotentReplay: true });
  });

  test("a WIN settles its BET and links it", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const bet = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", externalTransactionId: `bet-${wallet.id}` }),
    );

    const win = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, {
        kind: "WIN",
        money: { amount: "35.00", currency: "BRL" },
        referenceExternalTransactionId: `bet-${wallet.id}`,
      }),
    );

    expect(win.transaction).toMatchObject({
      status: "PROCESSED",
      referenceTransactionId: bet.transaction.id,
      balance: { amount: "125.00", currency: "BRL" },
    });
    expect(await balanceOf(sql, wallet.id)).toBe("125.00");
  });

  test("a REFUND that arrives before its BET waits, with its deadline and event", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");

    const result = await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "REFUND", referenceExternalTransactionId: "bet-late" }),
    );

    expect(result.transaction).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: { amount: "100.00", currency: "BRL" },
    });
    expect(result.transaction.referenceDeadline).not.toBeNull();
    expect((await outboxRows(sql, wallet.id)).at(-1)?.eventType).toBe(
      "WagerTransactionPendingReference",
    );
  });

  test("a BET is reversed at most once: a second REFUND is rejected", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const betId = `bet-${wallet.id}`;
    await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", externalTransactionId: betId }),
    );
    const refund = () =>
      useCases.submitWagerTransaction.execute(
        transactionCommand(wallet, { kind: "REFUND", referenceExternalTransactionId: betId }),
      );

    expect((await refund()).transaction.status).toBe(WagerTransactionStatus.Processed);
    expect((await refund()).transaction).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
    });
  });

  test("a queue message is recorded in the inbox; a redelivery is a no-op replay", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const message = { consumerName: "wager-transactions", messageId: Bun.randomUUIDv7() };
    const bet = transactionCommand(wallet, { kind: "BET", message });

    const first = await useCases.submitWagerTransaction.execute(bet);
    const redelivery = await useCases.submitWagerTransaction.execute(bet);
    // The provider resent the same transaction as a new message.
    const resentMessage = { ...message, messageId: Bun.randomUUIDv7() };
    const resent = await useCases.submitWagerTransaction.execute({
      ...bet,
      message: resentMessage,
    });

    expect(first).toMatchObject({ idempotentReplay: false, duplicateMessage: false });
    expect(redelivery).toMatchObject({ idempotentReplay: true, duplicateMessage: true });
    expect(resent).toMatchObject({ idempotentReplay: true, duplicateMessage: false });
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
    // Both messages are recorded once; the redelivery added nothing.
    const [row] = await sql`
      select count(*)::int as messages from inbox_messages
      where consumer_name = 'wager-transactions'
        and message_id in (${message.messageId}, ${resentMessage.messageId})`;
    expect(row).toEqual({ messages: 2 });
  });

  test("an unknown kind, or the internal OPENING, is an invalid payload", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");

    for (const kind of ["JACKPOT", "OPENING"]) {
      await expect(
        useCases.submitWagerTransaction.execute(transactionCommand(wallet, { kind })),
      ).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    }
  });

  test("a queue message id reused with another payload is refused, and nothing is done", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const message = { consumerName: "wager-transactions", messageId: Bun.randomUUIDv7() };
    await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", message }),
    );
    const before = await rowCounts(wallet.id);

    // A producer reused the message id for another transaction.
    await expect(
      useCases.submitWagerTransaction.execute(
        transactionCommand(wallet, {
          kind: "BET",
          money: { amount: "20.00", currency: "BRL" },
          message,
        }),
      ),
    ).rejects.toBeInstanceOf(InboxConflictError);
    expect(await rowCounts(wallet.id)).toEqual(before);
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
  });

  test("malformed input is a validation error, decided before any lock or lookup", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");

    const notAUuid = await useCases.submitWagerTransaction
      .execute(transactionCommand(wallet, { kind: "BET", walletId: "wallet-1" }))
      .catch((error: unknown) => error);
    expect(notAUuid).toBeInstanceOf(InvalidRequestError);
    expect(notAUuid).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ path: "walletId", message: "must be a lowercase UUID" }],
    });
    for (const overrides of [
      { externalTransactionId: "x".repeat(129) },
      // PostgreSQL text cannot hold NUL; no identifier needs a control character.
      { roundId: "round\u0000-1" },
      // UTF-8 would store an unpaired surrogate as U+FFFD, merging distinct ids into one.
      { idempotencyKey: "key-\ud800" },
      // SQS refuses U+FFFF in a message, so its events could never be published.
      { gameId: "game-\uFFFF" },
      // The canonical form only: an uppercase id would find the row, then differ from it.
      { walletId: wallet.id.toUpperCase() },
    ]) {
      await expect(
        useCases.submitWagerTransaction.execute(
          transactionCommand(wallet, { kind: "BET", ...overrides }),
        ),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    }
    expect(await balanceOf(setup().sql, wallet.id)).toBe("100.00");
    // An invalid payload for a wallet that does not exist is invalid first.
    await expect(
      useCases.submitWagerTransaction.execute(
        transactionCommand(wallet, { kind: "JACKPOT", walletId: Bun.randomUUIDv7() }),
      ),
    ).rejects.toBeInstanceOf(InvalidWagerTransactionError);
  });
});

/**
 * The first unit of work stops right before it writes its transaction, after every lookup has
 * found nothing, and resumes once `gate` opens: another request can commit in between.
 */
function pausingFirstInsert(gate: Promise<void>, onPaused: () => void) {
  let paused = false;
  return (inner: UnitOfWork): UnitOfWork => ({
    run: <T>(work: (repositories: Repositories) => Promise<T>) =>
      inner.run((repositories) => {
        if (paused) {
          return work(repositories);
        }
        paused = true;
        const { transactions } = repositories;
        return work({
          ...repositories,
          transactions: withInsert(transactions, async (transaction) => {
            onPaused();
            await gate;
            await transactions.add(transaction);
          }),
        });
      }),
  });
}

/**
 * Every unit of work fails as it writes its transaction, as a unique index out of step with the
 * lookups would.
 */
function failingInserts(failure: () => Error) {
  return (inner: UnitOfWork): UnitOfWork => ({
    run: <T>(work: (repositories: Repositories) => Promise<T>) =>
      inner.run((repositories) =>
        work({
          ...repositories,
          transactions: withInsert(repositories.transactions, () => Promise.reject(failure())),
        }),
      ),
  });
}

/** The repository as it is, except for how it inserts a transaction. */
function withInsert(
  transactions: WagerTransactionRepository,
  add: WagerTransactionRepository["add"],
): WagerTransactionRepository {
  return {
    find: (id) => transactions.find(id),
    findByIdempotencyKey: (key) => transactions.findByIdempotencyKey(key),
    findByExternalId: (providerId, externalId) =>
      transactions.findByExternalId(providerId, externalId),
    isReversed: (id) => transactions.isReversed(id),
    findDuePendingReferences: (now, limit) => transactions.findDuePendingReferences(now, limit),
    save: (transaction) => transactions.save(transaction),
    add,
  };
}

// The unique constraints are the backstop for races the wallet lock does not serialize: copies
// of one key on two different wallets. The loser rolls back, runs once more and answers from the
// winner's row; a duplicate never surfaces as a raw database error.
describe("SubmitWagerTransaction when a concurrent request wins a unique key", () => {
  let harness: UseCaseHarness | undefined;

  function setup(): UseCaseHarness {
    if (harness === undefined) {
      throw new Error("setup did not complete");
    }
    return harness;
  }

  beforeAll(async () => {
    harness = await openUseCaseHarness();
    // The provider's settlement account exists before any race. Otherwise the paused loser would
    // hold its first creation uncommitted, and the winner would wait for the loser, which waits
    // for the winner: a cycle only the pause creates (in production the creator never waits on
    // the other wallet, so the wait is short and bounded by lock_timeout).
    const warmUp = await openWallet(harness.useCases);
    await harness.useCases.submitWagerTransaction.execute(
      transactionCommand(warmUp, { kind: "BET" }),
    );
  });

  afterAll(() => cleanUp(() => harness?.close()));

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  async function race(
    loserCommand: SubmitWagerTransactionCommand,
    winnerCommand: SubmitWagerTransactionCommand,
  ) {
    const { useCases } = setup();
    const gate = deferred();
    const paused = deferred();
    const racing = setup().variant({
      wrapUnitOfWork: pausingFirstInsert(gate.promise, paused.resolve),
    });
    const loser = racing.submitWagerTransaction
      .execute(loserCommand)
      .catch((error: unknown) => error);
    await paused.promise;
    try {
      const winner = await useCases.submitWagerTransaction.execute(winnerCommand);
      gate.resolve();
      return { winner, loser: await loser };
    } finally {
      // Never leave the loser's transaction open, whatever happened to the winner.
      gate.resolve();
    }
  }

  test("the same idempotency key on two wallets answers a conflict, with one row stored", async () => {
    const { useCases, sql } = setup();
    const [first, second] = await Promise.all([openWallet(useCases), openWallet(useCases)]);
    if (first === undefined || second === undefined) {
      throw new Error("wallets not opened");
    }
    const key = `shared-${Bun.randomUUIDv7()}`;

    const { winner, loser } = await race(
      transactionCommand(first, { kind: "BET", idempotencyKey: key }),
      transactionCommand(second, { kind: "BET", idempotencyKey: key }),
    );

    expect(loser).toBeInstanceOf(IdempotencyConflictError);
    expect(loser).toMatchObject({ transactionId: winner.transaction.id });
    const [row] = await sql`
      select count(*)::int as stored from wager_transactions where idempotency_key = ${key}`;
    expect(row).toEqual({ stored: 1 });
    expect(await balanceOf(sql, first.id)).toBe("100.00");
  });

  test("the same queue message on two wallets: the loser's inbox insert fails, then an inbox conflict", async () => {
    const { useCases, sql } = setup();
    const [first, second] = await Promise.all([openWallet(useCases), openWallet(useCases)]);
    if (first === undefined || second === undefined) {
      throw new Error("wallets not opened");
    }
    const message = { consumerName: "wager-transactions", messageId: Bun.randomUUIDv7() };

    const { loser } = await race(
      transactionCommand(first, { kind: "BET", message }),
      transactionCommand(second, { kind: "BET", message }),
    );

    expect(loser).toBeInstanceOf(InboxConflictError);
    const [row] = await sql`
      select count(*)::int as recorded from inbox_messages where message_id = ${message.messageId}`;
    expect(row).toEqual({ recorded: 1 });
    expect(await balanceOf(sql, first.id)).toBe("100.00");
  });

  test("the same provider id under two keys answers a conflict, with one row stored", async () => {
    const { useCases, sql } = setup();
    const [first, second] = await Promise.all([openWallet(useCases), openWallet(useCases)]);
    if (first === undefined || second === undefined) {
      throw new Error("wallets not opened");
    }
    const externalTransactionId = `txn-${Bun.randomUUIDv7()}`;

    const { winner, loser } = await race(
      transactionCommand(first, { kind: "BET", externalTransactionId, idempotencyKey: "key-a" }),
      transactionCommand(second, { kind: "BET", externalTransactionId, idempotencyKey: "key-b" }),
    );

    expect(loser).toBeInstanceOf(ExternalTransactionConflictError);
    expect(loser).toMatchObject({ transactionId: winner.transaction.id });
    const [row] = await sql`
      select count(*)::int as stored from wager_transactions
      where external_transaction_id = ${externalTransactionId}`;
    expect(row).toEqual({ stored: 1 });
    expect(await balanceOf(sql, first.id)).toBe("100.00");
  });

  // The second run looks the winner's row up before inserting, so a violation on it is no
  // contention: only a bug, such as a unique index out of step with the lookups, gets there.
  test("a violation on the second run is a bug: it propagates, with nothing committed", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases);
    const command = transactionCommand(wallet, { kind: "BET" });
    let inserts = 0;
    const broken = setup().variant({
      wrapUnitOfWork: failingInserts(() => {
        inserts += 1;
        return new DuplicateKeyError("idempotency-key");
      }),
    });

    const error = await broken.submitWagerTransaction
      .execute(command)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DuplicateKeyError);
    // The first run and exactly one more.
    expect(inserts).toBe(2);
    const [row] = await sql`
      select count(*)::int as stored from wager_transactions
      where external_transaction_id = ${command.externalTransactionId}`;
    expect(row).toEqual({ stored: 0 });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });
});

describe("SubmitWagerTransaction on a contended wallet", () => {
  let harness: UseCaseHarness | undefined;

  beforeAll(async () => {
    harness = await openUseCaseHarness({ database: { lockTimeoutMs: 200 } });
  });

  afterAll(() => cleanUp(() => harness?.close()));

  test("a lock held past lock_timeout is a transient WALLET_BUSY, and nothing is stored", async () => {
    if (harness === undefined) {
      throw new Error("setup did not complete");
    }
    const { useCases, sql } = harness;
    const wallet = await openWallet(useCases, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });

    // Another session holds the wallet's row lock for the whole attempt.
    const outcome = await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      return useCases.submitWagerTransaction.execute(command).catch((error: unknown) => error);
    });

    expect(outcome).toBeInstanceOf(WalletBusyError);
    expect(outcome).toMatchObject({ code: "WALLET_BUSY" });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
    // Once the lock is gone, the same request goes through.
    const retried = await useCases.submitWagerTransaction.execute(command);
    expect(retried.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerDiscrepancies(sql)).toEqual([]);
  });
});
