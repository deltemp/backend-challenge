import { InboxMessageRecord } from "./inbox-message.record";
import { LedgerAccountRecord } from "./ledger-account.record";
import { LedgerEntryRecord } from "./ledger-entry.record";
import { OutboxMessageRecord } from "./outbox-message.record";
import { WagerTransactionRecord } from "./wager-transaction.record";
import { WalletRecord } from "./wallet.record";

export * from "./inbox-message.record";
export * from "./ledger-account.record";
export * from "./ledger-entry.record";
export * from "./outbox-message.record";
export * from "./wager-transaction.record";
export * from "./wallet.record";

/**
 * Every persistence record, registered with MikroORM. They map columns only, with no relations:
 * repositories resolve ids explicitly, and the schema itself (constraints and triggers in the
 * migrations) enforces the links between rows.
 */
export const PERSISTENCE_RECORDS = [
  WalletRecord,
  LedgerAccountRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];
