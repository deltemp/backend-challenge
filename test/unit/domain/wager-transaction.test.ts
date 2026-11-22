import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../src/domain/ledger/ledger-direction";
import { Money } from "../../../src/domain/money/money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  InvariantViolationError,
} from "../../../src/domain/shared/errors";
import { FailureCode, type RejectionCode } from "../../../src/domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import {
  at,
  brl,
  PLAYER,
  persisted,
  submit,
  T0,
  type TransactionOverrides,
  WALLET,
} from "./fixtures";

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

function parked(): WagerTransaction {
  const transaction = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });
  transaction.markPendingReference({
    deadline: at(15),
    nextAttemptAt: at(1),
    observedBalance: brl("100.00"),
    at: T0,
  });
  return transaction;
}

describe("WagerTransaction.create", () => {
  test("starts PENDING, with no outcome yet", () => {
    const transaction = submit({ kind: Bet, money: brl("25.00") });

    expect(transaction.status).toBe(Pending);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.observedBalance).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.isTerminal()).toBe(false);
  });

  test("OPENING is internal: a provider cannot submit it", () => {
    expect(() => submit({ kind: Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("REFUND and ROLLBACK need a reference", () => {
    expect(() => submit({ kind: Refund })).toThrow(InvalidWagerTransactionError);
    expect(() => submit({ kind: Rollback })).toThrow(InvalidWagerTransactionError);
  });

  test("a BET never references another transaction", () => {
    expect(() => submit({ kind: Bet, referenceExternalTransactionId: "bet-0" })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("WIN and LOSS may carry a reference, or not", () => {
    expect(submit({ kind: Win }).hasReference()).toBe(false);
    expect(submit({ kind: Win, referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(
      true,
    );
    expect(submit({ kind: Loss }).hasReference()).toBe(false);
    expect(submit({ kind: Loss, referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(
      true,
    );
  });

  test("amounts are positive, except that a LOSS may record zero", () => {
    for (const kind of [Bet, Win]) {
      expect(() => submit({ kind, money: Money.zero("BRL") })).toThrow(
        InvalidWagerTransactionError,
      );
    }
    for (const kind of [Refund, Rollback]) {
      expect(() =>
        submit({ kind, money: Money.zero("BRL"), referenceExternalTransactionId: "bet-1" }),
      ).toThrow(InvalidWagerTransactionError);
    }
    expect(submit({ kind: Loss, money: Money.zero("BRL") }).money.amount).toBe("0.00");
  });

  const emptyFields: ReadonlyArray<readonly [string, TransactionOverrides]> = [
    ["providerId", { kind: Win, providerId: "" }],
    ["externalTransactionId", { kind: Win, externalTransactionId: "" }],
    ["idempotencyKey", { kind: Win, idempotencyKey: "" }],
    ["walletId", { kind: Win, walletId: "" }],
    ["playerId", { kind: Win, playerId: "" }],
    ["roundId", { kind: Win, roundId: "" }],
    ["gameId", { kind: Win, gameId: "" }],
    ["referenceExternalTransactionId", { kind: Win, referenceExternalTransactionId: "" }],
  ];
  test.each(emptyFields)("rejects an empty %s", (_field, overrides) => {
    expect(() => submit(overrides)).toThrow(InvalidWagerTransactionError);
  });

  test("the payload hash must be a hex SHA-256 digest", () => {
    expect(() =>
      WagerTransaction.create({
        id: "id-1",
        providerId: "provider-a",
        externalTransactionId: "txn-1",
        idempotencyKey: "key-1",
        payloadHash: "not-a-digest",
        walletId: WALLET,
        playerId: PLAYER,
        roundId: "round-1",
        gameId: "game-1",
        kind: Bet,
        money: brl("1.00"),
        createdAt: T0,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe("WagerTransaction.opening", () => {
  test("is born PROCESSED, observing the initial balance, without provider fields", () => {
    const opening = WagerTransaction.opening({
      id: "opening-1",
      walletId: WALLET,
      playerId: PLAYER,
      money: brl("1000.00"),
      createdAt: T0,
    });

    expect(opening.status).toBe(Processed);
    expect(opening.kind).toBe(Opening);
    expect(opening.observedBalance?.amount).toBe("1000.00");
    expect(opening.processedAt).toEqual(T0);
    expect(opening.providerId).toBeUndefined();
    expect(opening.externalTransactionId).toBeUndefined();
    expect(opening.idempotencyKey).toBeUndefined();
    expect(opening.payloadHash).toBeUndefined();
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("credits a positive amount", () => {
    expect(() =>
      WagerTransaction.opening({
        id: "opening-1",
        walletId: WALLET,
        playerId: PLAYER,
        money: Money.zero("BRL"),
        createdAt: T0,
      }),
    ).toThrow(InvariantViolationError);
  });
});

// §6.3: PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE,
// PENDING_REFERENCE → PROCESSED | REJECTED | FAILED. Nothing leaves a terminal state.
describe("state machine", () => {
  test("PENDING → PROCESSED records the observed balance and the time", () => {
    const transaction = submit({ kind: Bet });

    transaction.markProcessed({
      referenceTransactionId: undefined,
      observedBalance: brl("75.00"),
      at: at(1),
    });

    expect(transaction.status).toBe(Processed);
    expect(transaction.observedBalance?.amount).toBe("75.00");
    expect(transaction.processedAt).toEqual(at(1));
    expect(transaction.updatedAt).toEqual(at(1));
    expect(transaction.isTerminal()).toBe(true);
  });

  test("PENDING → REJECTED records the failure code", () => {
    const transaction = submit({ kind: Bet });

    transaction.reject(FailureCode.InsufficientFunds, {
      observedBalance: brl("10.00"),
      at: at(1),
    });

    expect(transaction.status).toBe(Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.observedBalance?.amount).toBe("10.00");
  });

  test("PENDING → FAILED always carries INTERNAL_ERROR", () => {
    const transaction = submit({ kind: Bet });

    transaction.fail(at(1));

    expect(transaction.status).toBe(Failed);
    expect(transaction.failureCode).toBe(FailureCode.InternalError);
  });

  test("PENDING → PENDING_REFERENCE fixes the deadline and the next attempt", () => {
    const transaction = parked();

    expect(transaction.status).toBe(PendingReference);
    expect(transaction.referenceDeadline).toEqual(at(15));
    expect(transaction.nextAttemptAt).toEqual(at(1));
    expect(transaction.isTerminal()).toBe(false);
  });

  test("PENDING_REFERENCE → PROCESSED, REJECTED or FAILED", () => {
    const processed = parked();
    processed.markProcessed({
      referenceTransactionId: "id-bet",
      observedBalance: brl("125.00"),
      at: at(2),
    });
    expect(processed.status).toBe(Processed);
    expect(processed.referenceTransactionId).toBe("id-bet");
    expect(processed.nextAttemptAt).toBeUndefined();

    const rejected = parked();
    rejected.reject(FailureCode.ReferenceNotFound, { observedBalance: brl("1.00"), at: at(15) });
    expect(rejected.status).toBe(Rejected);
    expect(rejected.nextAttemptAt).toBeUndefined();

    const failed = parked();
    failed.fail(at(3));
    expect(failed.status).toBe(Failed);
    expect(failed.nextAttemptAt).toBeUndefined();
  });

  test("a retry of a parked transaction counts the attempt and keeps the deadline", () => {
    const transaction = parked();

    transaction.scheduleReferenceRetry({ nextAttemptAt: at(3), at: at(1) });

    expect(transaction.referenceAttempts).toBe(1);
    expect(transaction.nextAttemptAt).toEqual(at(3));
    expect(transaction.referenceDeadline).toEqual(at(15));
  });

  test("the next attempt is never scheduled past the deadline", () => {
    const transaction = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });
    expect(() =>
      transaction.markPendingReference({
        deadline: at(15),
        nextAttemptAt: at(16),
        observedBalance: brl("1.00"),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);

    const retried = parked();
    expect(() => retried.scheduleReferenceRetry({ nextAttemptAt: at(16), at: at(1) })).toThrow(
      InvariantViolationError,
    );
  });

  test("only a PENDING transaction with a reference can be parked", () => {
    const withoutReference = submit({ kind: Win });
    expect(() =>
      withoutReference.markPendingReference({
        deadline: at(15),
        nextAttemptAt: at(1),
        observedBalance: brl("1.00"),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      parked().markPendingReference({
        deadline: at(15),
        nextAttemptAt: at(1),
        observedBalance: brl("1.00"),
        at: T0,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  test("only a parked transaction is retried", () => {
    expect(() =>
      submit({ kind: Refund, referenceExternalTransactionId: "bet-1" }).scheduleReferenceRetry({
        nextAttemptAt: at(1),
        at: T0,
      }),
    ).toThrow(InvalidTransactionStateError);
  });

  test("a processed transaction records the internal id of its reference, and only then", () => {
    expect(() =>
      submit({ kind: Bet }).markProcessed({
        referenceTransactionId: "id-x",
        observedBalance: brl("1.00"),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);
    expect(() =>
      parked().markProcessed({
        referenceTransactionId: undefined,
        observedBalance: brl("1.00"),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);
  });

  test("INTERNAL_ERROR marks FAILED, never a rejection", () => {
    const internalError = FailureCode.InternalError as unknown as RejectionCode;

    expect(() =>
      submit({ kind: Bet }).reject(internalError, { observedBalance: undefined, at: T0 }),
    ).toThrow(InvariantViolationError);
  });

  describe.each([Processed, Rejected, Failed])("from the terminal state %s", (status) => {
    const decided = () => persisted({ kind: Bet, status });

    test("nothing can transition", () => {
      const transitions: ReadonlyArray<(transaction: WagerTransaction) => void> = [
        (t) =>
          t.markProcessed({
            referenceTransactionId: undefined,
            observedBalance: brl("1.00"),
            at: T0,
          }),
        (t) => t.reject(FailureCode.InsufficientFunds, { observedBalance: brl("1.00"), at: T0 }),
        (t) => t.fail(T0),
        (t) =>
          t.markPendingReference({
            deadline: at(15),
            nextAttemptAt: at(1),
            observedBalance: brl("1.00"),
            at: T0,
          }),
        (t) => t.scheduleReferenceRetry({ nextAttemptAt: at(1), at: T0 }),
      ];

      for (const transition of transitions) {
        const transaction = decided();
        expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
        expect(transaction.status).toBe(status);
      }
    });
  });
});

describe("queries", () => {
  test("only LOSS leaves the balance untouched", () => {
    expect(submit({ kind: Loss }).affectsBalance()).toBe(false);
    expect(submit({ kind: Bet }).affectsBalance()).toBe(true);
    expect(submit({ kind: Win }).affectsBalance()).toBe(true);
  });

  test("REFUND and ROLLBACK are reversals and require a reference", () => {
    const refund = submit({ kind: Refund, referenceExternalTransactionId: "bet-1" });
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "bet-1" });
    const win = submit({ kind: Win, referenceExternalTransactionId: "bet-1" });

    expect(refund.isReversal() && refund.requiresReference()).toBe(true);
    expect(rollback.isReversal() && rollback.requiresReference()).toBe(true);
    expect(win.isReversal() || win.requiresReference()).toBe(false);
  });

  test("ledger direction: BET debits; OPENING, WIN and REFUND credit; LOSS moves nothing", () => {
    expect(submit({ kind: Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(submit({ kind: Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      submit({ kind: Refund, referenceExternalTransactionId: "bet-1" }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
    expect(() => submit({ kind: Loss }).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test("a ROLLBACK mirrors the direction of its reference", () => {
    const rollback = submit({ kind: Rollback, referenceExternalTransactionId: "x" });

    expect(rollback.ledgerDirectionFor(submit({ kind: Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(submit({ kind: Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(submit({ kind: Refund, referenceExternalTransactionId: "y" })),
    ).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
  });

  test("rehydrates persisted state without validating its transitions again", () => {
    const transaction = persisted({
      kind: Refund,
      referenceExternalTransactionId: "bet-1",
      status: PendingReference,
    });

    expect(transaction.status).toBe(PendingReference);
    expect(transaction.referenceDeadline).toEqual(at(15));
  });
});
