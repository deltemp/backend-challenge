import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  InvalidRequestError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/application/errors";
import { InvalidMoneyError } from "../../src/domain/shared/errors";
import { ledgerDiscrepancies } from "../support/ledger";
import { openUseCaseHarness, outboxRows, type UseCaseHarness } from "../support/use-cases";

describe("OpenWallet and GetWallet", () => {
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

  // The final invariant of every integration test.
  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  test("an initial balance is credited by an OPENING transaction, its entry and its events", async () => {
    const { useCases, sql } = setup();

    const wallet = await useCases.openWallet.execute({
      playerId: "player-1",
      initialBalance: { amount: "1000", currency: "BRL" },
      correlationId: "correlation-1",
    });

    expect(wallet).toMatchObject({
      playerId: "player-1",
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    const transactions: { kind: string; status: string; amount: string }[] = await sql`
      select kind, status, amount::text as amount from wager_transactions
      where wallet_id = ${wallet.id}`;
    expect(transactions).toEqual([{ kind: "OPENING", status: "PROCESSED", amount: "1000.00" }]);
    const entries: { walletVersion: number; direction: string }[] = await sql`
      select wallet_version as "walletVersion", direction from ledger_entries
      where wallet_id = ${wallet.id}`;
    expect(entries).toEqual([{ walletVersion: 1, direction: "CREDIT" }]);
    expect((await outboxRows(sql, wallet.id)).map((row) => row.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("a wallet opened at zero has no transaction, no entry and no event", async () => {
    const { useCases, sql } = setup();

    const wallet = await useCases.openWallet.execute({
      playerId: "player-2",
      initialBalance: { amount: "0", currency: "BRL" },
      correlationId: "correlation-2",
    });

    expect(wallet.balance.amount).toBe("0.00");
    const [counts] = await sql`
      select
        (select count(*)::int from wager_transactions where wallet_id = ${wallet.id}) as transactions,
        (select count(*)::int from ledger_entries where wallet_id = ${wallet.id}) as entries`;
    expect(counts).toEqual({ transactions: 0, entries: 0 });
    expect(await outboxRows(sql, wallet.id)).toEqual([]);
  });

  test("a second wallet for the same player and currency is refused, naming the first", async () => {
    const { useCases } = setup();
    const first = await useCases.openWallet.execute({
      playerId: "player-3",
      initialBalance: { amount: "10.00", currency: "BRL" },
      correlationId: "c",
    });

    const error = await useCases.openWallet
      .execute({
        playerId: "player-3",
        initialBalance: { amount: "20.00", currency: "BRL" },
        correlationId: "c",
      })
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(error).toMatchObject({ code: "WALLET_ALREADY_EXISTS", walletId: first.id });
    // Another currency is another wallet.
    await useCases.openWallet.execute({
      playerId: "player-3",
      initialBalance: { amount: "20.00", currency: "USD" },
      correlationId: "c",
    });
  });

  test("concurrent openings of the same wallet: exactly one succeeds", async () => {
    const { useCases } = setup();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        useCases.openWallet.execute({
          playerId: "player-4",
          initialBalance: { amount: "50.00", currency: "BRL" },
          correlationId: "c",
        }),
      ),
    );

    const opened = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const refused = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(opened).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const reason of refused) {
      expect(reason).toBeInstanceOf(WalletAlreadyExistsError);
      expect(reason).toMatchObject({ walletId: opened[0]?.id });
    }
  });

  test("a player id the schema would refuse is a validation error", async () => {
    const { useCases } = setup();

    for (const playerId of ["", "p".repeat(129)]) {
      await expect(
        useCases.openWallet.execute({
          playerId,
          initialBalance: { amount: "1.00", currency: "BRL" },
          correlationId: "c",
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    }
  });

  test("an invalid initial balance opens nothing", async () => {
    const { useCases, sql } = setup();

    for (const amount of ["-1.00", "1.001", "1e3"]) {
      await expect(
        useCases.openWallet.execute({
          playerId: "player-5",
          initialBalance: { amount, currency: "BRL" },
          correlationId: "c",
        }),
      ).rejects.toBeInstanceOf(InvalidMoneyError);
    }
    const [row] =
      await sql`select count(*)::int as wallets from wallets where player_id = 'player-5'`;
    expect(row).toEqual({ wallets: 0 });
  });

  test("GetWallet returns the wallet, and refuses an unknown one", async () => {
    const { useCases } = setup();
    const opened = await useCases.openWallet.execute({
      playerId: "player-6",
      initialBalance: { amount: "7.50", currency: "BRL" },
      correlationId: "c",
    });

    expect(await useCases.getWallet.execute({ walletId: opened.id })).toEqual(opened);
    await expect(
      useCases.getWallet.execute({ walletId: Bun.randomUUIDv7() }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
