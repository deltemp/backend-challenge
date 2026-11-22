import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import { InvariantViolationError } from "../domain/shared/errors";
import {
  applyWagerTransaction,
  type ReferenceRetryPolicy,
  type ResolvedReference,
  type WagerOutcome,
} from "../domain/wagering/wager-rules";
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { IdGenerator } from "./ports/id-generator";
import type { Repositories, WagerTransactionRepository } from "./ports/repositories";

export interface ProcessWagerInput {
  /** Locked by the caller, first. */
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  readonly retryPolicy: ReferenceRetryPolicy;
  readonly ids: IdGenerator;
  readonly now: Date;
}

/**
 * Resolves the reference, applies the business rules and writes the balance movement, if any:
 * the shared core of a new transaction and of a parked one being reprocessed. The caller writes
 * the transaction itself and its events.
 */
export async function processWager(
  repositories: Repositories,
  input: ProcessWagerInput,
): Promise<WagerOutcome> {
  const { wallet, transaction } = input;
  const providerId = transaction.providerId;
  if (providerId === undefined) {
    throw new InvariantViolationError("only a provider's transaction is processed");
  }
  const reference = await resolveReference(repositories.transactions, transaction);
  // The wallet's currency: a movement only happens when the transaction's currency matches it.
  const settlementAccountId = await repositories.accounts.settlementAccount(
    providerId,
    wallet.currency,
  );
  const outcome = applyWagerTransaction({
    wallet,
    transaction,
    reference,
    settlementAccountId,
    ledgerEntryId: input.ids.next(),
    retryPolicy: input.retryPolicy,
    now: input.now,
  });
  const entry = ledgerEntryOf(outcome);
  if (entry !== undefined) {
    await repositories.wallets.save(wallet);
    await repositories.ledger.add(entry);
  }
  return outcome;
}

export function ledgerEntryOf(outcome: WagerOutcome): WalletLedgerEntry | undefined {
  return outcome.status === WagerTransactionStatus.Processed ? outcome.ledgerEntry : undefined;
}

/** Finds the reference by the provider and its id for the referenced transaction. */
async function resolveReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ResolvedReference | undefined> {
  const { providerId, referenceExternalTransactionId } = transaction;
  if (providerId === undefined || referenceExternalTransactionId === undefined) {
    return undefined;
  }
  const reference = await transactions.findByExternalId(providerId, referenceExternalTransactionId);
  if (reference === undefined) {
    return undefined;
  }
  return { transaction: reference, reversed: await transactions.isReversed(reference.id) };
}
