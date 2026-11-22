import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  InvalidCursorError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from "../../src/application/errors";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import { ledgerDiscrepancies } from "../support/ledger";
import {
  openUseCaseHarness,
  openWallet,
  transactionCommand,
  type UseCaseHarness,
} from "../support/use-cases";

/** Fails if reached: a query by an id that can match nothing must not run any SQL. */
const UNREACHABLE: UnitOfWork = {
  run: () => Promise.reject(new Error("the query reached the database")),
};

describe("queries and reconciliation", () => {
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

  test("the ledger is paginated newest first, with an opaque cursor to the older entries", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    for (let bet = 0; bet < 5; bet += 1) {
      await useCases.submitWagerTransaction.execute(transactionCommand(wallet, { kind: "BET" }));
    }

    const versions: number[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const result = await useCases.getWalletLedger.execute({
        walletId: wallet.id,
        cursor,
        limit: 2,
      });
      versions.push(result.entries.map((entry) => entry.walletVersion));
      cursor = result.nextCursor ?? undefined;
      if (page < 2) {
        expect(result.nextCursor).not.toBeNull();
      } else {
        expect(result.nextCursor).toBeNull();
      }
    }

    expect(versions).toEqual([
      [6, 5],
      [4, 3],
      [2, 1],
    ]);
    const first = await useCases.getWalletLedger.execute({ walletId: wallet.id, limit: 1 });
    expect(first.entries[0]).toMatchObject({
      walletVersion: 6,
      direction: "DEBIT",
      money: { amount: "10.00", currency: "BRL" },
      balanceBefore: { amount: "60.00", currency: "BRL" },
      balanceAfter: { amount: "50.00", currency: "BRL" },
    });
  });

  test("the ledger refuses a cursor it did not issue, and an unknown wallet", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");

    await expect(
      useCases.getWalletLedger.execute({ walletId: wallet.id, cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      useCases.getWalletLedger.execute({ walletId: Bun.randomUUIDv7() }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test("an id that is not a UUID matches nothing, without reaching the database", async () => {
    const { useCases } = setup();
    const unreachable = setup().variant({ wrapUnitOfWork: () => UNREACHABLE });

    await expect(unreachable.getWallet.execute({ walletId: "wallet-1" })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
    await expect(
      unreachable.getWalletLedger.execute({ walletId: "wallet-1" }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(
      unreachable.reconcileWallet.execute({ walletId: "1; drop" }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(
      unreachable.getWagerTransaction.byId({ transactionId: "txn-1" }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
    // Only the canonical lowercase form names a wallet.
    const wallet = await openWallet(useCases, "1.00");
    await expect(
      unreachable.getWallet.execute({ walletId: wallet.id.toUpperCase() }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test("a provider identifier the use cases refuse matches nothing, without reaching the database", async () => {
    const { useCases } = setup();
    const unreachable = setup().variant({ wrapUnitOfWork: () => UNREACHABLE });
    const wallet = await openWallet(useCases, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    await useCases.submitWagerTransaction.execute(command);
    const { providerId, externalTransactionId } = command;
    // Values are written into the SQL text, where a NUL would end the protocol message early.
    const withNul = { providerId, externalTransactionId: `${externalTransactionId}\u0000` };

    await expect(useCases.getWagerTransaction.byExternalId(withNul)).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
    for (const lookup of [
      withNul,
      { providerId, externalTransactionId: "" },
      { providerId, externalTransactionId: "x".repeat(129) },
      { providerId: "p".repeat(65), externalTransactionId },
      { providerId: `${providerId}\n`, externalTransactionId },
      { providerId, externalTransactionId: `${externalTransactionId}\ud800` },
    ]) {
      await expect(unreachable.getWagerTransaction.byExternalId(lookup)).rejects.toBeInstanceOf(
        TransactionNotFoundError,
      );
    }
  });

  test("a transaction is found by its id and by the provider's id", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const command = transactionCommand(wallet, { kind: "BET" });
    const { transaction } = await useCases.submitWagerTransaction.execute(command);

    expect(await useCases.getWagerTransaction.byId({ transactionId: transaction.id })).toEqual(
      transaction,
    );
    expect(
      await useCases.getWagerTransaction.byExternalId({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
      }),
    ).toEqual(transaction);
    await expect(
      useCases.getWagerTransaction.byId({ transactionId: Bun.randomUUIDv7() }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(
      useCases.getWagerTransaction.byExternalId({
        providerId: command.providerId,
        externalTransactionId: "nope",
      }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });

  test("reconciliation confirms a balance that matches its ledger", async () => {
    const { useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    await useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, { kind: "BET", money: { amount: "12.34", currency: "BRL" } }),
    );

    expect(await useCases.reconcileWallet.execute({ walletId: wallet.id })).toEqual({
      walletId: wallet.id,
      version: 2,
      storedBalance: { amount: "87.66", currency: "BRL" },
      calculatedBalance: { amount: "87.66", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
    await expect(
      useCases.reconcileWallet.execute({ walletId: Bun.randomUUIDv7() }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test("reconciliation reports a divergence and corrects nothing", async () => {
    const { useCases, sql } = setup();
    const wallet = await openWallet(useCases, "100.00");
    // The schema refuses this; only a session that disables triggers can corrupt a balance.
    const corrupt = (delta: string) =>
      sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update wallets set balance = balance + ${delta}::numeric where id = ${wallet.id}`;
      });
    await corrupt("5.00");

    try {
      const report = await useCases.reconcileWallet.execute({ walletId: wallet.id });

      expect(report).toMatchObject({
        storedBalance: { amount: "105.00", currency: "BRL" },
        calculatedBalance: { amount: "100.00", currency: "BRL" },
        difference: { amount: "5.00", currency: "BRL" },
        consistent: false,
      });
      const [row] = await sql`select balance::text as balance from wallets where id = ${wallet.id}`;
      expect(row).toEqual({ balance: "105.00" });
    } finally {
      await corrupt("-5.00");
    }
  });
});
