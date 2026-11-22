import type { LedgerDirection } from "../ledger/ledger-direction";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { MoneyProps } from "../money/money";
import { InvariantViolationError } from "../shared/errors";
import type { FailureCode } from "../wagering/failure-code";
import {
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../wagering/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from "./integration-event";

// ---- WalletBalanceChanged ------------------------------------------------------------------

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/** Raised only when the balance changes, once per ledger entry. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  readonly orderingKey: string;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
    this.orderingKey = props.data.walletId;
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError("the entry must belong to the wallet");
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

// ---- Wagering transaction events ------------------------------------------------------------

/** Fields every transaction event carries. Provider fields are null for the internal OPENING. */
export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly kind: WagerTransactionKind;
  readonly walletId: string;
  readonly playerId: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  readonly referenceTransactionId: string | null;
  /** The balance observed right after the transaction was applied. */
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: FailureCode;
  /** Null when the wallet belongs to another player or holds another currency. */
  readonly balance: MoneyProps | null;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  readonly referenceExternalTransactionId: string;
  readonly referenceDeadline: string;
}

export interface WagerTransactionFailedData extends WagerTransactionEventData {
  /** Always INTERNAL_ERROR. */
  readonly failureCode: FailureCode;
  /** The balance observed when the transaction was parked. */
  readonly balance: MoneyProps | null;
}

function transactionData(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    kind: transaction.kind,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
  };
}

function requireStatus(transaction: WagerTransaction, status: WagerTransactionStatus): void {
  if (transaction.status !== status) {
    throw new InvariantViolationError(
      `transaction ${transaction.id} is ${transaction.status}, not ${status}`,
    );
  }
}

/** Raised for every applied transaction, including LOSS and the internal OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  readonly orderingKey: string;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
    this.orderingKey = props.data.walletId;
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    requireStatus(transaction, WagerTransactionStatus.Processed);
    const { observedBalance, processedAt } = transaction;
    if (observedBalance === undefined || processedAt === undefined) {
      throw new InvariantViolationError("a processed transaction has a balance and a time");
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: observedBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

/** Raised for a business rejection, including a reference that never arrived. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  readonly orderingKey: string;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
    this.orderingKey = props.data.walletId;
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    requireStatus(transaction, WagerTransactionStatus.Rejected);
    const { failureCode } = transaction;
    if (failureCode === undefined) {
      throw new InvariantViolationError("a rejected transaction has a failure code");
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode,
        balance: transaction.observedBalance?.toJSON() ?? null,
      },
    });
  }
}

/** Raised when a transaction is parked to wait for its reference. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  readonly orderingKey: string;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
    this.orderingKey = props.data.walletId;
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    requireStatus(transaction, WagerTransactionStatus.PendingReference);
    const { referenceExternalTransactionId, referenceDeadline } = transaction;
    if (referenceExternalTransactionId === undefined || referenceDeadline === undefined) {
      throw new InvariantViolationError("a parked transaction has a reference and a deadline");
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        referenceExternalTransactionId,
        referenceDeadline: referenceDeadline.toISOString(),
      },
    });
  }
}

/**
 * Raised when a parked transaction ends FAILED: its reprocessing hit an unrecoverable,
 * non-business error. Every terminal outcome has its event, so consumers learn it is over.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;
  readonly orderingKey: string;

  private constructor(props: IntegrationEventProps<WagerTransactionFailedData>) {
    super(props);
    this.orderingKey = props.data.walletId;
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionFailed {
    requireStatus(transaction, WagerTransactionStatus.Failed);
    const { failureCode } = transaction;
    if (failureCode === undefined) {
      throw new InvariantViolationError("a failed transaction has a failure code");
    }
    return new WagerTransactionFailed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...transactionData(transaction),
        failureCode,
        balance: transaction.observedBalance?.toJSON() ?? null,
      },
    });
  }
}
