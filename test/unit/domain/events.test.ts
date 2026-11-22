import { describe, expect, test } from "bun:test";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../src/domain/events/events";
import type { EventContext } from "../../../src/domain/events/integration-event";
import { LedgerDirection } from "../../../src/domain/ledger/ledger-direction";
import { InvariantViolationError } from "../../../src/domain/shared/errors";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { apply, at, brl, openWallet, PLAYER, submit, T0, usd, WALLET } from "./fixtures";

const context: EventContext = {
  eventId: "event-1",
  correlationId: "correlation-1",
  causationId: "message-1",
  occurredAt: at(1),
};

/** Every amount in an event is a decimal string: no number ever reaches the wire. */
function amountsIn(json: string): unknown[] {
  return [...json.matchAll(/"amount":([^,}]+)/g)].map((match) => JSON.parse(match[1] ?? "null"));
}

describe("WalletBalanceChanged", () => {
  test("describes one ledger entry, keyed by the wallet", () => {
    const wallet = openWallet("100.00");
    const bet = submit({ kind: WagerTransactionKind.Bet, money: brl("30.00") });
    const outcome = apply(wallet, bet);
    if (outcome.status !== WagerTransactionStatus.Processed || outcome.ledgerEntry === undefined) {
      throw new Error("expected a ledger entry");
    }

    const event = WalletBalanceChanged.from(wallet, outcome.ledgerEntry, context);

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(WALLET);
    expect(event.orderingKey).toBe(WALLET);
    expect(event.data).toEqual({
      walletId: WALLET,
      transactionId: bet.id,
      direction: LedgerDirection.Debit,
      money: { amount: "30.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "70.00", currency: "BRL" },
      walletVersion: 2,
    });
    expect(amountsIn(JSON.stringify(event)).every((amount) => typeof amount === "string")).toBe(
      true,
    );
  });

  test("refuses an entry of another wallet", () => {
    const wallet = openWallet("100.00");
    const other = openWallet("100.00", { id: "wallet-2" });
    const outcome = apply(other, submit({ kind: WagerTransactionKind.Bet, walletId: "wallet-2" }));
    if (outcome.status !== WagerTransactionStatus.Processed || outcome.ledgerEntry === undefined) {
      throw new Error("expected a ledger entry");
    }
    const entryOfOtherWallet = outcome.ledgerEntry;

    expect(() => WalletBalanceChanged.from(wallet, entryOfOtherWallet, context)).toThrow(
      InvariantViolationError,
    );
  });
});

describe("WagerTransactionProcessed", () => {
  test("carries the transaction, the reference and the balance observed", () => {
    const wallet = openWallet("100.00");
    const win = submit({ kind: WagerTransactionKind.Win, money: brl("12.50") });
    apply(wallet, win);

    const event = WagerTransactionProcessed.from(win, context);

    expect(event.eventType).toBe("WagerTransactionProcessed");
    expect(event.aggregateId).toBe(win.id);
    expect(event.orderingKey).toBe(WALLET);
    expect(event.data).toMatchObject({
      transactionId: win.id,
      kind: "WIN",
      walletId: WALLET,
      playerId: PLAYER,
      providerId: "provider-a",
      money: { amount: "12.50", currency: "BRL" },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      balance: { amount: "112.50", currency: "BRL" },
      processedAt: T0.toISOString(),
    });
  });

  test("of the internal OPENING has null provider fields", () => {
    const opening = WagerTransaction.opening({
      id: "opening-1",
      walletId: WALLET,
      playerId: PLAYER,
      money: brl("1000.00"),
      createdAt: T0,
    });

    const event = WagerTransactionProcessed.from(opening, context);

    expect(event.data).toMatchObject({
      kind: "OPENING",
      providerId: null,
      externalTransactionId: null,
      roundId: null,
      gameId: null,
      balance: { amount: "1000.00", currency: "BRL" },
    });
  });

  test("is raised only for a PROCESSED transaction", () => {
    expect(() =>
      WagerTransactionProcessed.from(submit({ kind: WagerTransactionKind.Bet }), context),
    ).toThrow(InvariantViolationError);
  });
});

describe("WagerTransactionRejected", () => {
  test("carries the failure code and the balance observed", () => {
    const wallet = openWallet("10.00");
    const bet = submit({ kind: WagerTransactionKind.Bet, money: brl("50.00") });
    apply(wallet, bet);

    const event = WagerTransactionRejected.from(bet, context);

    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.data).toMatchObject({
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: "10.00", currency: "BRL" },
    });
  });

  test("discloses no balance when the wallet belongs to another player or currency", () => {
    const wallet = openWallet("10.00");
    const bet = submit({ kind: WagerTransactionKind.Bet, money: usd("5.00") });
    apply(wallet, bet);

    expect(WagerTransactionRejected.from(bet, context).data).toMatchObject({
      failureCode: FailureCode.CurrencyMismatch,
      balance: null,
    });
  });

  test("is raised only for a REJECTED transaction", () => {
    expect(() =>
      WagerTransactionRejected.from(submit({ kind: WagerTransactionKind.Bet }), context),
    ).toThrow(InvariantViolationError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("carries the missing reference and the deadline", () => {
    const wallet = openWallet("100.00");
    const refund = submit({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-late",
    });
    apply(wallet, refund);

    const event = WagerTransactionPendingReference.from(refund, context);

    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.data).toMatchObject({
      referenceExternalTransactionId: "bet-late",
      referenceDeadline: at(15).toISOString(),
    });
  });

  test("is raised only for a parked transaction", () => {
    expect(() =>
      WagerTransactionPendingReference.from(
        submit({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "b" }),
        context,
      ),
    ).toThrow(InvariantViolationError);
  });
});

describe("envelope", () => {
  test("serializes to stable JSON, with the type and version declared by the class", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: WagerTransactionKind.Loss });
    apply(wallet, loss);

    const envelope = WagerTransactionProcessed.from(loss, context).toJSON();

    expect(envelope).toMatchObject({
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: loss.id,
      correlationId: "correlation-1",
      causationId: "message-1",
      occurredAt: at(1).toISOString(),
      version: 1,
    });
    expect(JSON.parse(JSON.stringify(envelope)).data.money).toEqual({
      amount: "25.00",
      currency: "BRL",
    });
  });

  test("omits the causation id when there is none", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: WagerTransactionKind.Loss });
    apply(wallet, loss);

    const envelope = WagerTransactionProcessed.from(loss, {
      eventId: "event-2",
      correlationId: "correlation-2",
      occurredAt: at(1),
    }).toJSON();

    expect("causationId" in envelope).toBe(false);
  });

  test("its data is frozen", () => {
    const wallet = openWallet("100.00");
    const loss = submit({ kind: WagerTransactionKind.Loss });
    apply(wallet, loss);

    expect(Object.isFrozen(WagerTransactionProcessed.from(loss, context).data)).toBe(true);
  });
});
