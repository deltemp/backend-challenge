import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/**
 * An account of the double-entry ledger, insert-only. It has no balance column, and no foreign
 * key points at it from the ledger: the balance of a counter-account is always derived from its
 * entries, so no row is updated or locked by every wallet. Get or create one with
 * `INSERT … ON CONFLICT DO NOTHING` and a read; never lock it.
 */
export const LedgerAccountRecord = defineEntity({
  name: "LedgerAccountRecord",
  tableName: "ledger_accounts",
  properties: {
    id: p.uuid().primary().columnType("uuid"),
    type: p.text().columnType("text"),
    currency: p.string().columnType("char(3)"),
    walletId: p.uuid().columnType("uuid").nullable(),
    providerId: p.text().columnType("text").nullable(),
    createdAt: p.datetime().columnType("timestamptz"),
  },
});

export type LedgerAccountRow = InferEntity<typeof LedgerAccountRecord>;
