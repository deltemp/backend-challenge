import type { LedgerAccount } from "../../domain/ledger/ledger-account";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

// Repositories are bound to one unit of work: every call runs inside its SQL transaction.

export interface WalletRepository {
  /**
   * Locks the wallet's row (`SELECT … FOR UPDATE`) and returns the wallet. Every unit of work
   * that changes a wallet takes this lock first, before reading anything its decision depends
   * on. Undefined when the wallet does not exist.
   */
  lock(id: string): Promise<Wallet | undefined>;
  /**
   * Locks the row unless another transaction holds it (`FOR UPDATE SKIP LOCKED`). Undefined
   * when the wallet is locked or missing. For workers, which simply come back later.
   */
  lockIfFree(id: string): Promise<Wallet | undefined>;
  /** Reads the wallet without locking it, for queries. */
  find(id: string): Promise<Wallet | undefined>;
  findIdByOwner(playerId: string, currency: string): Promise<string | undefined>;
  add(wallet: Wallet): Promise<void>;
  /** Writes the balance, the version and the update time. */
  save(wallet: Wallet): Promise<void>;
}

export interface LedgerAccountRepository {
  add(account: LedgerAccount): Promise<void>;
  /**
   * The provider's settlement account in the currency, created on first use. Never locks the
   * row: it is shared by every wallet of the provider.
   */
  settlementAccount(providerId: string, currency: string): Promise<string>;
  /** The FUNDING account of the currency, created on first use, never locked. */
  fundingAccount(currency: string): Promise<string>;
}

export interface WagerTransactionRepository {
  find(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Whether a PROCESSED REFUND or ROLLBACK of the transaction exists. */
  isReversed(id: string): Promise<boolean>;
  /** Ids of the PENDING_REFERENCE transactions due at `now`, oldest first. Locks nothing. */
  findDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  add(transaction: WagerTransaction): Promise<void>;
  /** Writes the outcome of a stored PENDING_REFERENCE transaction. */
  save(transaction: WagerTransaction): Promise<void>;
}

/** The stored balance of a wallet and the balance rebuilt from its entries, in one snapshot. */
export interface LedgerSummary {
  readonly walletId: string;
  readonly version: number;
  readonly storedBalance: Money;
  /** May be negative in a corrupted ledger; reconciliation reports it, never corrects it. */
  readonly calculatedBalance: Money;
  readonly entries: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): Promise<void>;
  /** Entries of the wallet from the newest, older than `beforeVersion` when it is given. */
  page(
    walletId: string,
    options: { readonly beforeVersion: number | undefined; readonly limit: number },
  ): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string): Promise<LedgerSummary | undefined>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /**
   * Locks and returns due events, at most one per wallet: its oldest unpublished event, and
   * only when no other publisher holds it (`FOR UPDATE SKIP LOCKED`). Oldest first.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Writes the attempts, the next attempt and the publication time. */
  save(message: OutboxMessage): Promise<void>;
}

export interface Repositories {
  readonly wallets: WalletRepository;
  readonly accounts: LedgerAccountRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}
