import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvariantViolationError } from "../../../src/domain/shared/errors";
import { Wallet } from "../../../src/domain/wallet/wallet";
import {
  at,
  brl,
  FUNDING_ACCOUNT,
  openWallet,
  PLAYER,
  SETTLEMENT_ACCOUNT,
  T0,
  usd,
} from "./fixtures";

function movement(amount: string, overrides: { currency?: string } = {}) {
  return {
    entryId: "entry-x",
    transactionId: "txn-x",
    money: Money.from({ amount, currency: overrides.currency ?? "BRL" }),
    counterAccountId: SETTLEMENT_ACCOUNT,
    at: at(1),
  };
}

// §13 unit: invariants of the Wallet.
describe("Wallet", () => {
  test("opens at version 1 with an OPENING credit drawn from the funding account", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: PLAYER,
      initialBalance: brl("1000.00"),
      openedAt: T0,
      opening: {
        transactionId: "opening-1",
        entryId: "entry-1",
        fundingAccountId: FUNDING_ACCOUNT,
      },
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toMatchObject({
      walletId: "wallet-1",
      walletVersion: 1,
      transactionId: "opening-1",
      direction: LedgerDirection.Credit,
      debitAccountId: FUNDING_ACCOUNT,
      creditAccountId: "wallet-1",
    });
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("1000.00");
  });

  test("opens at zero without any ledger entry", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: PLAYER,
      initialBalance: Money.zero("BRL"),
      openedAt: T0,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("needs an OPENING credit exactly when the initial balance is above zero", () => {
    const opening = { transactionId: "o", entryId: "e", fundingAccountId: FUNDING_ACCOUNT };

    expect(() =>
      Wallet.open({ id: "w", playerId: PLAYER, initialBalance: brl("10.00"), openedAt: T0 }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: PLAYER,
        initialBalance: Money.zero("BRL"),
        openedAt: T0,
        opening,
      }),
    ).toThrow(InvariantViolationError);
  });

  test("a credit raises the balance, advances the version by one and records the entry", () => {
    const wallet = openWallet("100.00");

    const entry = wallet.credit(movement("40.00"));

    expect(wallet.balance.amount).toBe("140.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(at(1));
    expect(entry).toMatchObject({
      walletVersion: 2,
      direction: LedgerDirection.Credit,
      debitAccountId: SETTLEMENT_ACCOUNT,
      creditAccountId: wallet.id,
    });
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("140.00");
  });

  test("a debit lowers the balance, down to exactly zero", () => {
    const wallet = openWallet("100.00");

    const entry = wallet.debit(movement("100.00"));

    expect(wallet.balance.amount).toBe("0.00");
    expect(entry).toMatchObject({
      direction: LedgerDirection.Debit,
      debitAccountId: wallet.id,
      creditAccountId: SETTLEMENT_ACCOUNT,
    });
  });

  test("a debit never takes the balance below zero, and a refused debit changes nothing", () => {
    const wallet = openWallet("100.00");

    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(() => wallet.debit(movement("100.01"))).toThrow(InvariantViolationError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("the operation's currency must be the wallet's", () => {
    const wallet = openWallet("100.00");

    expect(() => wallet.credit(movement("1.00", { currency: "USD" }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.canDebit(usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("a movement must be positive", () => {
    const wallet = openWallet("100.00");

    expect(() => wallet.credit(movement("0.00"))).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test("the version only advances when the balance changes", () => {
    const wallet = openWallet("100.00");

    wallet.canDebit(brl("50.00"));
    expect(wallet.version).toBe(1);
    wallet.debit(movement("50.00"));
    wallet.credit(movement("20.00"));
    expect(wallet.version).toBe(3);
  });

  test("rehydrates persisted state as it is, without validating it again", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: PLAYER,
      currency: "BRL",
      balance: brl("12.34"),
      version: 7,
      createdAt: T0,
      updatedAt: at(5),
    });

    expect(wallet.balance.amount).toBe("12.34");
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(at(5));
  });
});

describe("WalletLedgerEntry", () => {
  const valid = {
    id: "entry-1",
    walletId: "wallet-1",
    walletVersion: 2,
    transactionId: "txn-1",
    direction: LedgerDirection.Debit,
    money: brl("30.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("70.00"),
    debitAccountId: "wallet-1",
    creditAccountId: SETTLEMENT_ACCOUNT,
    createdAt: T0,
  };

  test("checks its arithmetic: balanceBefore ± money equals balanceAfter", () => {
    expect(WalletLedgerEntry.create(valid).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...valid, balanceAfter: brl("80.00") })).toThrow(
      InvariantViolationError,
    );
  });

  test("moves a positive amount between two different accounts, with the wallet on its own side", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...valid, money: Money.zero("BRL"), balanceAfter: brl("100.00") }),
    ).toThrow(InvariantViolationError);
    expect(() => WalletLedgerEntry.create({ ...valid, creditAccountId: "wallet-1" })).toThrow(
      InvariantViolationError,
    );
    expect(() =>
      WalletLedgerEntry.create({
        ...valid,
        debitAccountId: SETTLEMENT_ACCOUNT,
        creditAccountId: "wallet-1",
      }),
    ).toThrow(InvariantViolationError);
  });

  test("keeps one currency across amount and balances", () => {
    expect(() => WalletLedgerEntry.create({ ...valid, money: usd("30.00") })).toThrow(
      CurrencyMismatchError,
    );
  });

  test("is immutable by structure: frozen, with no transition method", () => {
    const entry = WalletLedgerEntry.create(valid);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));

    expect(Object.isFrozen(entry)).toBe(true);
    expect(methods.sort()).toEqual(["constructor", "isBalanced"]);
  });

  test("rehydrates without validating again", () => {
    const entry = WalletLedgerEntry.rehydrate({ ...valid, balanceAfter: brl("1.00") });

    expect(entry.isBalanced()).toBe(false);
  });
});
