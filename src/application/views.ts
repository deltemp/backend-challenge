import type { LedgerDirection } from "../domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import type { MoneyProps } from "../domain/money/money";
import type { FailureCode } from "../domain/wagering/failure-code";
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";

// Plain, serializable outputs of the use cases: decimal strings for money, ISO strings for time.

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WagerTransactionView {
  readonly id: string;
  readonly providerId: string | null;
  readonly externalTransactionId: string | null;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  /** The balance observed when the outcome was decided, which a replay returns; null on a wallet mismatch. */
  readonly balance: MoneyProps | null;
  readonly processedAt: string | null;
  readonly referenceDeadline: string | null;
  readonly createdAt: string;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly walletVersion: number;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly createdAt: string;
}

export function walletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function wagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
    referenceDeadline: transaction.referenceDeadline?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  };
}

export function ledgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    debitAccountId: entry.debitAccountId,
    creditAccountId: entry.creditAccountId,
    createdAt: entry.createdAt.toISOString(),
  };
}
