import { LedgerDirection } from "../ledger/ledger-direction";
import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { FullJitterBackoff } from "../shared/backoff";
import { InvalidTransactionStateError, InvariantViolationError } from "../shared/errors";
import type { Wallet } from "../wallet/wallet";
import { FailureCode, type RejectionCode } from "./failure-code";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

/** A reference found by `(providerId, referenceExternalTransactionId)`. */
export interface ResolvedReference {
  readonly transaction: WagerTransaction;
  /** Whether a PROCESSED REFUND or ROLLBACK of this transaction already exists. */
  readonly reversed: boolean;
}

/** How long a transaction waits for its reference, and how its attempts are spaced. */
export interface ReferenceRetryPolicy {
  readonly ttlMs: number;
  readonly backoff: FullJitterBackoff;
}

export interface ApplyWagerTransactionInput {
  /** The wallet named by the transaction, locked by the caller. */
  readonly wallet: Wallet;
  /** PENDING when first received, PENDING_REFERENCE when reprocessed by the retry worker. */
  readonly transaction: WagerTransaction;
  /** Undefined when the transaction has no reference, or when it was not found. */
  readonly reference: ResolvedReference | undefined;
  /** The PROVIDER_SETTLEMENT account of the transaction's provider and currency. */
  readonly settlementAccountId: string;
  readonly ledgerEntryId: string;
  readonly retryPolicy: ReferenceRetryPolicy;
  readonly now: Date;
}

export type WagerOutcome =
  | {
      readonly status: WagerTransactionStatus.Processed;
      /** Absent for LOSS, which does not move the balance. */
      readonly ledgerEntry: WalletLedgerEntry | undefined;
    }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: RejectionCode }
  | { readonly status: WagerTransactionStatus.PendingReference };

/** Kinds each operation may reference. */
const REFERENCEABLE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

type ReferenceCheck =
  | { readonly verdict: "resolved"; readonly reference: WagerTransaction }
  | { readonly verdict: "rejected"; readonly code: RejectionCode }
  | { readonly verdict: "wait"; readonly codeOnExpiry: RejectionCode };

/**
 * Applies the business rules (§7) to one transaction, updating the wallet and the transaction,
 * and returns the outcome. When several rules are broken, the first one in this order is
 * reported:
 *
 * 1. the wallet belongs to another player (WALLET_PLAYER_MISMATCH);
 * 2. the currency differs from the wallet's (CURRENCY_MISMATCH);
 * 3. for a transaction with a reference: the reference is missing (wait); it belongs to another
 *    provider, player, wallet, currency or round (REFERENCE_MISMATCH); it is of a kind this
 *    operation cannot reference (REFERENCE_KIND_NOT_ALLOWED); it is still pending (wait); it
 *    ended REJECTED or FAILED (REFERENCE_NOT_PROCESSED); it was already reversed
 *    (REFERENCE_ALREADY_REVERSED); a reversal's amount differs (AMOUNT_MISMATCH);
 * 4. a debit beyond the balance (INSUFFICIENT_FUNDS for a BET, REVERSAL_WOULD_OVERDRAW for a
 *    ROLLBACK).
 *
 * The scope of a reference is checked before anything else about it, so a provider learns
 * nothing about transactions outside its own player, wallet and round.
 */
export function applyWagerTransaction(input: ApplyWagerTransactionInput): WagerOutcome {
  const { wallet, transaction, now } = input;
  if (transaction.walletId !== wallet.id) {
    throw new InvariantViolationError("the transaction must be applied to the wallet it names");
  }
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`transaction ${transaction.id} is already decided`);
  }

  // Mismatched wallets are rejected without a balance snapshot: the balance is not the caller's.
  if (wallet.playerId !== transaction.playerId) {
    transaction.reject(FailureCode.WalletPlayerMismatch, { observedBalance: undefined, at: now });
    return rejected(FailureCode.WalletPlayerMismatch);
  }
  if (wallet.currency !== transaction.money.currency) {
    transaction.reject(FailureCode.CurrencyMismatch, { observedBalance: undefined, at: now });
    return rejected(FailureCode.CurrencyMismatch);
  }

  let reference: WagerTransaction | undefined;
  if (transaction.hasReference()) {
    const check = checkReference(transaction, input.reference);
    if (check.verdict === "rejected") {
      return reject(input, check.code);
    }
    if (check.verdict === "wait") {
      return wait(input, check.codeOnExpiry);
    }
    reference = check.reference;
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      observedBalance: wallet.balance,
      at: now,
    });
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    return reject(
      input,
      transaction.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds,
    );
  }
  const movement = {
    entryId: input.ledgerEntryId,
    transactionId: transaction.id,
    money: transaction.money,
    counterAccountId: input.settlementAccountId,
    at: now,
  };
  const ledgerEntry =
    direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed({
    referenceTransactionId: reference?.id,
    observedBalance: wallet.balance,
    at: now,
  });
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function checkReference(
  transaction: WagerTransaction,
  resolved: ResolvedReference | undefined,
): ReferenceCheck {
  if (resolved === undefined) {
    return { verdict: "wait", codeOnExpiry: FailureCode.ReferenceNotFound };
  }
  const reference = resolved.transaction;
  const sameScope =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId;
  if (!sameScope) {
    return { verdict: "rejected", code: FailureCode.ReferenceMismatch };
  }
  if (!(REFERENCEABLE_KINDS[transaction.kind] ?? []).includes(reference.kind)) {
    return { verdict: "rejected", code: FailureCode.ReferenceKindNotAllowed };
  }
  if (reference.status === WagerTransactionStatus.PendingReference) {
    return { verdict: "wait", codeOnExpiry: FailureCode.ReferenceNotProcessed };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { verdict: "rejected", code: FailureCode.ReferenceNotProcessed };
  }
  // At most one reversal per reference, and no WIN or LOSS for a bet that was reversed.
  if (resolved.reversed) {
    return { verdict: "rejected", code: FailureCode.ReferenceAlreadyReversed };
  }
  if (transaction.isReversal() && !reference.money.equals(transaction.money)) {
    return { verdict: "rejected", code: FailureCode.AmountMismatch };
  }
  return { verdict: "resolved", reference };
}

/**
 * Parks the transaction until its reference is resolved, or rejects it once its deadline has
 * passed. The deadline is fixed when the transaction is first parked (receipt plus TTL), the
 * next attempt never comes after it, and a rejection only follows a real lookup made at or after
 * the deadline: this function only runs after one.
 */
function wait(input: ApplyWagerTransactionInput, codeOnExpiry: RejectionCode): WagerOutcome {
  const { transaction, wallet, retryPolicy, now } = input;
  const deadline =
    transaction.referenceDeadline ?? new Date(transaction.createdAt.getTime() + retryPolicy.ttlMs);
  if (now >= deadline) {
    return reject(input, codeOnExpiry);
  }
  if (transaction.status === WagerTransactionStatus.Pending) {
    transaction.markPendingReference({
      deadline,
      nextAttemptAt: retryPolicy.backoff.nextAttemptAt(now, 0, deadline),
      observedBalance: wallet.balance,
      at: now,
    });
  } else {
    transaction.scheduleReferenceRetry({
      nextAttemptAt: retryPolicy.backoff.nextAttemptAt(
        now,
        transaction.referenceAttempts + 1,
        deadline,
      ),
      at: now,
    });
  }
  return { status: WagerTransactionStatus.PendingReference };
}

function reject(input: ApplyWagerTransactionInput, code: RejectionCode): WagerOutcome {
  input.transaction.reject(code, { observedBalance: input.wallet.balance, at: input.now });
  return rejected(code);
}

function rejected(code: RejectionCode): WagerOutcome {
  return { status: WagerTransactionStatus.Rejected, failureCode: code };
}
