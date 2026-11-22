import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/**
 * One movement of the double-entry ledger: append-only, enforced by the schema. It names the
 * debited and credited accounts and a positive amount, plus the wallet side of the movement
 * (`direction`, the balances around it and the wallet version it produced).
 */
export const LedgerEntryRecord = defineEntity({
  name: "LedgerEntryRecord",
  tableName: "ledger_entries",
  properties: {
    id: p.uuid().primary().columnType("uuid"),
    transactionId: p.uuid().columnType("uuid"),
    walletId: p.uuid().columnType("uuid"),
    walletVersion: p.integer().columnType("integer"),
    direction: p.text().columnType("text"),
    debitAccountId: p.uuid().columnType("uuid"),
    creditAccountId: p.uuid().columnType("uuid"),
    amount: p.decimal("string").columnType("numeric(20,2)"),
    currency: p.string().columnType("char(3)"),
    balanceBefore: p.decimal("string").columnType("numeric(20,2)"),
    balanceAfter: p.decimal("string").columnType("numeric(20,2)"),
    createdAt: p.datetime().columnType("timestamptz"),
  },
  uniques: [
    { name: "ledger_entries_transaction_id_unique", properties: ["transactionId"] },
    { name: "ledger_entries_wallet_version_unique", properties: ["walletId", "walletVersion"] },
  ],
});

export type LedgerEntryRow = InferEntity<typeof LedgerEntryRecord>;
