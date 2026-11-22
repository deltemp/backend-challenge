import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import {
  InvalidTransactionStateError,
  InvariantViolationError,
} from "../../../src/domain/shared/errors";
import { FailureCode, type RejectionCode } from "../../../src/domain/wagering/failure-code";
import type { WagerOutcome } from "../../../src/domain/wagering/wager-rules";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";
import {
  apply,
  at,
  brl,
  FUNDING_ACCOUNT,
  openWallet,
  PLAYER,
  persisted,
  processedBet,
  SETTLEMENT_ACCOUNT,
  submit,
  T0,
  type TransactionOverrides,
  usd,
  WALLET,
} from "./fixtures";

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

function entryOf(outcome: WagerOutcome): WalletLedgerEntry {
  if (outcome.status !== Processed || outcome.ledgerEntry === undefined) {
    throw new Error(`expected a ledger entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.ledgerEntry;
}

function plus(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

function rejection(failureCode: RejectionCode): WagerOutcome {
  return { status: Rejected, failureCode };
}

const PARKED: WagerOutcome = { status: PendingReference };

test("failure codes are a public contract: none renamed, none added silently", () => {
  const codes: string[] = Object.values(FailureCode);

  expect(codes.sort()).toEqual([
    "AMOUNT_MISMATCH",
    "CURRENCY_MISMATCH",
    "INSUFFICIENT_FUNDS",
    "INTERNAL_ERROR",
    "REFERENCE_ALREADY_REVERSED",
    "REFERENCE_KIND_NOT_ALLOWED",
    "REFERENCE_MISMATCH",
    "REFERENCE_NOT_FOUND",
    "REFERENCE_NOT_PROCESSED",
    "REVERSAL_WOULD_OVERDRAW",
    "WALLET_PLAYER_MISMATCH",
  ]);
});

// §13 unit: rules of BET, WIN, LOSS, REFUND and ROLLBACK.
describe("BET", () => {
  test("debits the wallet, with a DEBIT entry against the provider's settlement account", () => {
    const wallet = openWallet("100.00");
    const bet = submit({ kind: Bet, money: brl("30.00") });

    const entry = entryOf(apply(wallet, bet));

    expect(wallet.balance.amount).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(bet.status).toBe(Processed);
    expect(bet.observedBalance?.amount).toBe("70.00");
    expect(bet.referenceTransactionId).toBeUndefined();
    expect(entry).toMatchObject({
      transactionId: bet.id,
      walletVersion: 2,
      direction: LedgerDirection.Debit,
      debitAccountId: wallet.id,
      creditAccountId: SETTLEMENT_ACCOUNT,
    });
    expect(entry.money.amount).toBe("30.00");
  });

  test("may take the balance to exactly zero", () => {
    const wallet = openWallet("30.00");

    apply(wallet, submit({ kind: Bet, money: brl("30.00") }));

    expect(wallet.balance.amount).toBe("0.00");
  });

  test("beyond the balance is REJECTED with INSUFFICIENT_FUNDS and moves nothing", () => {
    const wallet = openWallet("20.00");
    const bet = submit({ kind: Bet, money: brl("20.01") });

    expect(apply(wallet, bet)).toEqual(rejection(FailureCode.InsufficientFunds));
    expect(bet.status).toBe(Rejected);
    expect(bet.observedBalance?.amount).toBe("20.00");
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  test("§8 under the wallet lock: two 80.00 bets against 100.00, exactly one is debited", () => {
    const wallet = openWallet("100.00");
    const first = submit({ kind: Bet, money: brl("80.00") });
    const second = submit({ kind: Bet, money: brl("80.00") });

    const outcomes = [apply(wallet, first), apply(wallet, second)];

    expect(outcomes.filter((outcome) => outcome.status === Processed)).toHaveLength(1);
    expect(outcomes[1]).toEqual(rejection(FailureCode.InsufficientFunds));
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });
});

describe("WIN", () => {
  test("without a reference credits the wallet", () => {
    const wallet = openWallet("100.00");
    const win = submit({ kind: Win, money: brl("50.00") });

    const entry = entryOf(apply(wallet, win));

    expect(wallet.balance.amount).toBe("150.00");
    expect(entry).toMatchObject({
      direction: LedgerDirection.Credit,
      debitAccountId: SETTLEMENT_ACCOUNT,
      creditAccountId: wallet.id,
    });
  });

  test("with a reference to a PROCESSED BET of the same scope credits and links the BET", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet("25.00", { externalTransactionId: "bet-1" });
    // A payout is not tied to the stake: only reversals must match their reference's amount.
    const win = submit({ kind: Win, money: brl("60.00"), referenceExternalTransactionId: "bet-1" });

    apply(wallet, win, { transaction: bet });

    expect(win.status).toBe(Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe("160.00");
  });

  const otherScopes: ReadonlyArray<readonly [string, Partial<TransactionOverrides>]> = [
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["round", { roundId: "round-2" }],
    ["currency", { money: usd("25.00") }],
  ];
  test.each(otherScopes)(
    "referencing a BET of another %s is REJECTED with REFERENCE_MISMATCH",
    (_scope, overrides) => {
      const wallet = openWallet("100.00");
      const bet = persisted({
        kind: Bet,
        status: Processed,
        money: brl("25.00"),
        ...overrides,
      });
      const win = submit({ kind: Win, money: brl("60.00"), referenceExternalTransactionId: "b" });

      expect(apply(wallet, win, { transaction: bet })).toEqual(
        rejection(FailureCode.ReferenceMismatch),
      );
      expect(wallet.balance.amount).toBe("100.00");
    },
  );

  test("can only reference a BET", () => {
    const wallet = openWallet("100.00");
    const otherWin = persisted({ kind: Win, status: Processed });
    const win = submit({ kind: Win, referenceExternalTransactionId: "win-0" });

    expect(apply(wallet, win, { transaction: otherWin })).toEqual(
      rejection(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("for a BET that was reversed is REJECTED with REFERENCE_ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const win = submit({ kind: Win, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, win, { transaction: processedBet(), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test.each([Rejected, Failed])(
    "for a BET that ended %s is REJECTED with REFERENCE_NOT_PROCESSED",
    (status) => {
      const wallet = openWallet("100.00");
      const win = submit({ kind: Win, referenceExternalTransactionId: "bet-1" });

      expect(apply(wallet, win, { transaction: persisted({ kind: Bet, status }) })).toEqual(
        rejection(FailureCode.ReferenceNotProcessed),
      );
    },
  );

  test("for a BET that has not arrived waits in PENDING_REFERENCE", () => {
    const wallet = openWallet("100.00");
    const win = submit({ kind: Win, referenceExternalTransactionId: "bet-late" });

    expect(apply(wallet, win)).toEqual(PARKED);
    expect(wallet.balance.amount).toBe("100.00");
  });
});

describe("LOSS", () => {
  test("is PROCESSED without moving the balance or writing a ledger entry", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: Loss, money: brl("25.00") });

    expect(apply(wallet, loss)).toEqual({ status: Processed, ledgerEntry: undefined });
    expect(loss.status).toBe(Processed);
    expect(loss.observedBalance?.amount).toBe("100.00");
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("may record zero", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: Loss, money: Money.zero("BRL") });

    apply(wallet, loss);

    expect(loss.status).toBe(Processed);
  });

  test("with a reference to a PROCESSED BET is linked to it", () => {
    const wallet = openWallet("100.00");
    const bet = processedBet();
    const loss = submit({ kind: Loss, referenceExternalTransactionId: "bet-1" });

    apply(wallet, loss, { transaction: bet });

    expect(loss.referenceTransactionId).toBe(bet.id);
    expect(wallet.version).toBe(1);
  });

  test("for a BET that was reversed is REJECTED with REFERENCE_ALREADY_REVERSED", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: Loss, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, loss, { transaction: processedBet(), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test("can only reference a BET", () => {
    const wallet = openWallet("100.00");
    const refund = persisted({
      kind: Refund,
      referenceExternalTransactionId: "b",
      status: Processed,
    });
    const loss = submit({ kind: Loss, referenceExternalTransactionId: "refund-1" });

    expect(apply(wallet, loss, { transaction: refund })).toEqual(
      rejection(FailureCode.ReferenceKindNotAllowed),
    );
  });
});

describe("REFUND", () => {
  test("credits the stake of its BET back and links the BET", () => {
    const wallet = openWallet("75.00");
    const bet = processedBet("25.00", { externalTransactionId: "bet-1" });
    const refund = submit({
      kind: Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });

    const entry = entryOf(apply(wallet, refund, { transaction: bet }));

    expect(wallet.balance.amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test("must match the amount of its BET (AMOUNT_MISMATCH)", () => {
    const wallet = openWallet("75.00");
    const refund = submit({
      kind: Refund,
      money: brl("25.01"),
      referenceExternalTransactionId: "b",
    });

    expect(apply(wallet, refund, { transaction: processedBet("25.00") })).toEqual(
      rejection(FailureCode.AmountMismatch),
    );
    expect(wallet.balance.amount).toBe("75.00");
  });

  test("can only reverse a BET", () => {
    const wallet = openWallet("100.00");
    const win = persisted({ kind: Win, status: Processed });
    const refund = submit({ kind: Refund, referenceExternalTransactionId: "win-1" });

    expect(apply(wallet, refund, { transaction: win })).toEqual(
      rejection(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("a BET is reversed at most once (REFERENCE_ALREADY_REVERSED)", () => {
    const wallet = openWallet("75.00");
    const refund = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, refund, { transaction: processedBet(), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
    expect(wallet.balance.amount).toBe("75.00");
  });

  test("documented limitation: a REFUND undone by a ROLLBACK does not reopen its BET", () => {
    // The first REFUND stays PROCESSED after its ROLLBACK, so the BET still counts as reversed.
    const wallet = openWallet("75.00");
    const secondRefund = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, secondRefund, { transaction: processedBet(), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits the stake back", () => {
    const wallet = openWallet("75.00");
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "bet-1" });

    const entry = entryOf(apply(wallet, rollback, { transaction: processedBet("25.00") }));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("of a WIN debits the payout", () => {
    const wallet = openWallet("150.00");
    const win = persisted({ kind: Win, status: Processed, money: brl("50.00") });
    const rollback = submit({
      kind: Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: "win-1",
    });

    const entry = entryOf(apply(wallet, rollback, { transaction: win }));

    expect(entry).toMatchObject({
      direction: LedgerDirection.Debit,
      debitAccountId: wallet.id,
      creditAccountId: SETTLEMENT_ACCOUNT,
    });
    expect(wallet.balance.amount).toBe("100.00");
    expect(rollback.referenceTransactionId).toBe(win.id);
  });

  test("of a REFUND debits the refunded stake", () => {
    const wallet = openWallet("100.00");
    const refund = persisted({
      kind: Refund,
      status: Processed,
      referenceExternalTransactionId: "bet-1",
    });
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "refund-1" });

    apply(wallet, rollback, { transaction: refund });

    expect(wallet.balance.amount).toBe("75.00");
  });

  test("that would overdraw is REJECTED with REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS", () => {
    const wallet = openWallet("10.00");
    const win = persisted({ kind: Win, status: Processed, money: brl("50.00") });
    const rollback = submit({
      kind: Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: "win-1",
    });

    expect(apply(wallet, rollback, { transaction: win })).toEqual(
      rejection(FailureCode.ReversalWouldOverdraw),
    );
    expect(rollback.observedBalance?.amount).toBe("10.00");
    expect(wallet.balance.amount).toBe("10.00");
    expect(wallet.version).toBe(1);
  });

  test.each([Loss, Rollback])("cannot reverse a %s", (kind) => {
    const wallet = openWallet("100.00");
    const reference = persisted({ kind, status: Processed, referenceExternalTransactionId: "x" });
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "y" });

    expect(apply(wallet, rollback, { transaction: reference })).toEqual(
      rejection(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("and a REFUND of the same transaction are mutually exclusive", () => {
    const wallet = openWallet("100.00");
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, rollback, { transaction: processedBet(), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test("must match the amount of its reference (AMOUNT_MISMATCH)", () => {
    const wallet = openWallet("100.00");
    const rollback = submit({
      kind: Rollback,
      money: brl("24.99"),
      referenceExternalTransactionId: "bet-1",
    });

    expect(apply(wallet, rollback, { transaction: processedBet("25.00") })).toEqual(
      rejection(FailureCode.AmountMismatch),
    );
  });
});

// §7.1: a reference that has not arrived yet.
describe("missing reference", () => {
  const refundOfLateBet = (createdAt = T0) =>
    submit({ kind: Refund, referenceExternalTransactionId: "bet-late", createdAt });
  const lateBet = () => processedBet("25.00", { externalTransactionId: "bet-late" });

  test("parks the transaction with a deadline of receipt + TTL, moving nothing", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();

    expect(apply(wallet, refund)).toEqual(PARKED);
    expect(refund.status).toBe(PendingReference);
    expect(refund.referenceDeadline).toEqual(at(15));
    expect(refund.nextAttemptAt).toEqual(plus(T0, 500));
    expect(refund.observedBalance?.amount).toBe("75.00");
    expect(wallet.balance.amount).toBe("75.00");
    expect(wallet.version).toBe(1);
  });

  test("the deadline counts from receipt, not from the first lookup", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet(T0);

    apply(wallet, refund, undefined, at(5));

    expect(refund.referenceDeadline).toEqual(at(15));
  });

  test("while it is still missing, each retry is counted and paced with full jitter", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();
    apply(wallet, refund);

    apply(wallet, refund, undefined, at(1));
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextAttemptAt).toEqual(plus(at(1), 1000));

    apply(wallet, refund, undefined, at(2));
    expect(refund.referenceAttempts).toBe(2);
    expect(refund.nextAttemptAt).toEqual(plus(at(2), 2000));
    expect(refund.referenceDeadline).toEqual(at(15));
  });

  test("the next attempt is never scheduled past the deadline", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();
    apply(wallet, refund);

    apply(wallet, refund, undefined, plus(at(15), -1));

    expect(refund.status).toBe(PendingReference);
    expect(refund.nextAttemptAt).toEqual(at(15));
  });

  test("once the reference arrives, the transaction is processed", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();
    apply(wallet, refund);
    const bet = lateBet();

    entryOf(apply(wallet, refund, { transaction: bet }, at(3)));

    expect(refund.status).toBe(Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(refund.processedAt).toEqual(at(3));
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("a lookup at the deadline that still finds nothing rejects it with REFERENCE_NOT_FOUND", () => {
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();
    apply(wallet, refund);

    expect(apply(wallet, refund, undefined, at(15))).toEqual(
      rejection(FailureCode.ReferenceNotFound),
    );
    expect(refund.observedBalance?.amount).toBe("75.00");
  });

  test("a reference found by a lookup made after the deadline is still applied", () => {
    // Rejection needs a lookup that fails at or after the deadline, even if the worker was down.
    const wallet = openWallet("75.00");
    const refund = refundOfLateBet();
    apply(wallet, refund);

    apply(wallet, refund, { transaction: lateBet() }, at(40));

    expect(refund.status).toBe(Processed);
  });
});

// A reference that exists but is itself still waiting: the ROLLBACK of a REFUND whose BET has
// not arrived.
describe("pending reference chain", () => {
  const refundWaiting = () =>
    persisted({
      kind: Refund,
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-late",
      status: PendingReference,
    });
  const rollbackOfRefund = () =>
    submit({ kind: Rollback, referenceExternalTransactionId: "refund-1", createdAt: at(2) });

  test("the dependant waits too, with its own deadline", () => {
    const wallet = openWallet("100.00");
    const rollback = rollbackOfRefund();

    expect(apply(wallet, rollback, { transaction: refundWaiting() }, at(2))).toEqual(PARKED);
    expect(rollback.referenceDeadline).toEqual(at(17));
  });

  test("it proceeds once its reference is PROCESSED", () => {
    const wallet = openWallet("100.00");
    const rollback = rollbackOfRefund();
    apply(wallet, rollback, { transaction: refundWaiting() }, at(2));
    const refundProcessed = persisted({
      kind: Refund,
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-late",
      status: Processed,
    });

    apply(wallet, rollback, { transaction: refundProcessed }, at(4));

    expect(rollback.status).toBe(Processed);
    expect(wallet.balance.amount).toBe("75.00");
  });

  test.each([Rejected, Failed])(
    "it is REJECTED with REFERENCE_NOT_PROCESSED when its reference ends %s",
    (status) => {
      const wallet = openWallet("100.00");
      const rollback = rollbackOfRefund();
      apply(wallet, rollback, { transaction: refundWaiting() }, at(2));
      const refundDecided = persisted({
        kind: Refund,
        referenceExternalTransactionId: "bet-late",
        status,
      });

      expect(apply(wallet, rollback, { transaction: refundDecided }, at(4))).toEqual(
        rejection(FailureCode.ReferenceNotProcessed),
      );
    },
  );

  test("it is REJECTED with REFERENCE_NOT_PROCESSED when its reference is still pending at its deadline", () => {
    const wallet = openWallet("100.00");
    const rollback = rollbackOfRefund();
    apply(wallet, rollback, { transaction: refundWaiting() }, at(2));

    expect(apply(wallet, rollback, { transaction: refundWaiting() }, at(17))).toEqual(
      rejection(FailureCode.ReferenceNotProcessed),
    );
  });
});

// §13 unit: currency conflict.
describe("currency conflict", () => {
  test("a transaction in another currency is REJECTED with CURRENCY_MISMATCH, moving nothing", () => {
    const wallet = openWallet("100.00");
    const bet = submit({ kind: Bet, money: usd("10.00") });

    expect(apply(wallet, bet)).toEqual(rejection(FailureCode.CurrencyMismatch));
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("wallets in other currencies follow the same rules", () => {
    const wallet = openWallet("100.00", { currency: "USD" });

    apply(wallet, submit({ kind: Bet, money: usd("40.00") }));

    expect(wallet.balance.toJSON()).toEqual({ amount: "60.00", currency: "USD" });
    expect(apply(wallet, submit({ kind: Win, money: brl("1.00") }))).toEqual(
      rejection(FailureCode.CurrencyMismatch),
    );
  });
});

// When several rules are broken, the first in the documented order is reported.
describe("rule precedence", () => {
  test("a wallet of another player comes first, and its balance is not disclosed", () => {
    const wallet = openWallet("10.00");
    const bet = submit({ kind: Bet, playerId: "player-2", money: usd("50.00") });

    expect(apply(wallet, bet)).toEqual(rejection(FailureCode.WalletPlayerMismatch));
    expect(bet.observedBalance).toBeUndefined();
    expect(wallet.balance.amount).toBe("10.00");
  });

  test("a currency mismatch comes next, also without disclosing the balance", () => {
    const wallet = openWallet("10.00");
    const bet = submit({ kind: Bet, money: usd("50.00") });

    apply(wallet, bet);

    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(bet.observedBalance).toBeUndefined();
  });

  test("the scope of a reference is checked before anything else about it", () => {
    const wallet = openWallet("100.00");
    const foreignLoss = persisted({ kind: Loss, status: Rejected, roundId: "round-2" });
    const rollback = submit({
      kind: Rollback,
      money: brl("99.00"),
      referenceExternalTransactionId: "l",
    });

    expect(apply(wallet, rollback, { transaction: foreignLoss, reversed: true })).toEqual(
      rejection(FailureCode.ReferenceMismatch),
    );
  });

  test("a reference of another scope is rejected even while it is still pending", () => {
    const wallet = openWallet("100.00");
    const foreignRefund = persisted({
      kind: Refund,
      status: PendingReference,
      referenceExternalTransactionId: "bet-x",
      playerId: "player-2",
    });
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "refund-x" });

    expect(apply(wallet, rollback, { transaction: foreignRefund })).toEqual(
      rejection(FailureCode.ReferenceMismatch),
    );
  });

  test("the kind of the reference comes before its status", () => {
    const wallet = openWallet("100.00");
    const rejectedWin = persisted({ kind: Win, status: Rejected });
    const refund = submit({ kind: Refund, referenceExternalTransactionId: "win-1" });

    expect(apply(wallet, refund, { transaction: rejectedWin })).toEqual(
      rejection(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("the status of the reference comes before a previous reversal", () => {
    const wallet = openWallet("100.00");
    const rejectedBet = persisted({ kind: Bet, status: Rejected });
    const refund = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });

    expect(apply(wallet, refund, { transaction: rejectedBet, reversed: true })).toEqual(
      rejection(FailureCode.ReferenceNotProcessed),
    );
  });

  test("a previous reversal comes before an amount mismatch", () => {
    const wallet = openWallet("100.00");
    const refund = submit({
      kind: Refund,
      money: brl("99.00"),
      referenceExternalTransactionId: "b",
    });

    expect(apply(wallet, refund, { transaction: processedBet("25.00"), reversed: true })).toEqual(
      rejection(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test("an amount mismatch comes before the funds check", () => {
    const wallet = openWallet("10.00");
    const win = persisted({ kind: Win, status: Processed, money: brl("50.00") });
    const rollback = submit({
      kind: Rollback,
      money: brl("99.00"),
      referenceExternalTransactionId: "w",
    });

    expect(apply(wallet, rollback, { transaction: win })).toEqual(
      rejection(FailureCode.AmountMismatch),
    );
  });
});

describe("guard rails", () => {
  test("a transaction is applied only to the wallet it names", () => {
    const wallet = openWallet("100.00");

    expect(() => apply(wallet, submit({ kind: Bet, walletId: "wallet-2" }))).toThrow(
      InvariantViolationError,
    );
  });

  test("a decided transaction is never applied again", () => {
    const wallet = openWallet("100.00");

    expect(() => apply(wallet, processedBet())).toThrow(InvalidTransactionStateError);
    expect(wallet.version).toBe(1);
  });
});

describe("outcome snapshot", () => {
  test("keeps the balance observed when it was decided, whatever happens afterwards", () => {
    const wallet = openWallet("100.00");
    const first = submit({ kind: Bet, money: brl("30.00") });
    const second = submit({ kind: Bet, money: brl("30.00") });

    apply(wallet, first);
    apply(wallet, second);

    expect(first.observedBalance?.amount).toBe("70.00");
    expect(second.observedBalance?.amount).toBe("40.00");
  });
});

// Final invariant of §13, at the domain level: the balance rebuilt from the ledger.
test("after any sequence of operations, wallet.balance equals the balance rebuilt from the ledger", () => {
  const { wallet, openingEntry } = Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: brl("100.00"),
    openedAt: T0,
    opening: { transactionId: "opening-1", entryId: "entry-0", fundingAccountId: FUNDING_ACCOUNT },
  });
  const entries: WalletLedgerEntry[] = openingEntry === undefined ? [] : [openingEntry];
  const record = (outcome: WagerOutcome) => {
    if (outcome.status === Processed && outcome.ledgerEntry !== undefined) {
      entries.push(outcome.ledgerEntry);
    }
  };

  const bet = submit({ kind: Bet, money: brl("30.00") });
  record(apply(wallet, bet));
  const win = submit({ kind: Win, money: brl("45.50"), referenceExternalTransactionId: "bet" });
  record(apply(wallet, win, { transaction: bet }));
  record(apply(wallet, submit({ kind: Loss, money: Money.zero("BRL") })));
  const stake = submit({ kind: Bet, money: brl("20.25") });
  record(apply(wallet, stake));
  record(
    apply(
      wallet,
      submit({ kind: Refund, money: brl("20.25"), referenceExternalTransactionId: "stake" }),
      { transaction: stake },
    ),
  );
  record(
    apply(
      wallet,
      submit({ kind: Rollback, money: brl("45.50"), referenceExternalTransactionId: "win" }),
      { transaction: win },
    ),
  );
  record(apply(wallet, submit({ kind: Bet, money: brl("1000.00") })));

  const rebuilt = entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    Money.zero("BRL"),
  );
  expect(rebuilt.equals(wallet.balance)).toBe(true);
  expect(wallet.balance.amount).toBe("70.00");
  expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(entries.every((entry) => entry.isBalanced())).toBe(true);
  expect(wallet.version).toBe(6);
});
