import type { LedgerAccount } from "../../../domain/ledger/ledger-account";
import { LedgerDirection } from "../../../domain/ledger/ledger-direction";
import { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { Money } from "../../../domain/money/money";
import { InvariantViolationError } from "../../../domain/shared/errors";
import { FailureCode } from "../../../domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import type {
  InboxMessageRow,
  LedgerEntryRow,
  OutboxMessageRow,
  WagerTransactionRow,
  WalletRow,
} from "../records";

// Records are not domain objects: rows become domain objects through `rehydrate`, and domain
// objects become plain row data. Amounts stay decimal strings on the way in and out.

function member<T extends string>(values: readonly T[], value: string, what: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new InvariantViolationError(`unknown ${what} in the database: ${value}`);
  }
  return found;
}

const KINDS = Object.values(WagerTransactionKind);
const STATUSES = Object.values(WagerTransactionStatus);
const FAILURE_CODES = Object.values(FailureCode);
const DIRECTIONS = Object.values(LedgerDirection);

function present<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/** A stored amount, never negative. */
export function money(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

/** A computed amount that may be negative, such as a balance rebuilt from a corrupted ledger. */
export function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith("-")
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: money(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function walletRow(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function accountRow(account: LedgerAccount) {
  return {
    id: account.id,
    type: account.type,
    currency: account.currency,
    walletId: account.walletId ?? null,
    providerId: account.providerId ?? null,
    createdAt: account.createdAt,
  };
}

export function wagerTransactionFromRow(row: WagerTransactionRow): WagerTransaction {
  const currency = row.currency;
  const failureCode = present(row.failureCode);
  const observedBalance = present(row.observedBalance);
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: present(row.providerId),
    externalTransactionId: present(row.externalTransactionId),
    idempotencyKey: present(row.idempotencyKey),
    payloadHash: present(row.payloadHash),
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: present(row.roundId),
    gameId: present(row.gameId),
    kind: member(KINDS, row.kind, "transaction kind"),
    money: money(row.amount, currency),
    referenceExternalTransactionId: present(row.referenceExternalTransactionId),
    createdAt: row.createdAt,
    status: member(STATUSES, row.status, "transaction status"),
    referenceTransactionId: present(row.referenceTransactionId),
    failureCode:
      failureCode === undefined ? undefined : member(FAILURE_CODES, failureCode, "failure code"),
    processedAt: present(row.processedAt),
    observedBalance: observedBalance === undefined ? undefined : money(observedBalance, currency),
    referenceDeadline: present(row.referenceDeadline),
    nextAttemptAt: present(row.nextAttemptAt),
    referenceAttempts: row.referenceAttempts,
    updatedAt: row.updatedAt,
  });
}

export function wagerTransactionRow(transaction: WagerTransaction) {
  return {
    id: transaction.id,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    idempotencyKey: transaction.idempotencyKey ?? null,
    payloadHash: transaction.payloadHash ?? null,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    createdAt: transaction.createdAt,
    ...wagerTransactionOutcome(transaction),
  };
}

/** The columns a stored PENDING_REFERENCE transaction may still change. */
export function wagerTransactionOutcome(transaction: WagerTransaction) {
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    observedBalance: transaction.observedBalance?.amount ?? null,
    referenceDeadline: transaction.referenceDeadline ?? null,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    referenceAttempts: transaction.referenceAttempts,
    updatedAt: transaction.updatedAt,
  };
}

export function ledgerEntryFromRow(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    walletVersion: row.walletVersion,
    transactionId: row.transactionId,
    direction: member(DIRECTIONS, row.direction, "ledger direction"),
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency),
    balanceAfter: money(row.balanceAfter, row.currency),
    debitAccountId: row.debitAccountId,
    creditAccountId: row.creditAccountId,
    createdAt: row.createdAt,
  });
}

export function ledgerEntryRow(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletId: entry.walletId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    debitAccountId: entry.debitAccountId,
    creditAccountId: entry.creditAccountId,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  };
}

export function inboxMessageFromRow(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: present(row.processedAt),
  });
}

export function inboxMessageRow(message: InboxMessage) {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function outboxMessageFromRow(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    orderingKey: row.orderingKey,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: present(row.nextAttemptAt),
    publishedAt: present(row.publishedAt),
  });
}

export function outboxMessageRow(message: OutboxMessage) {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    orderingKey: message.orderingKey,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    ...outboxMessageSchedule(message),
  };
}

/** The columns the publisher changes. */
export function outboxMessageSchedule(message: OutboxMessage) {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}
