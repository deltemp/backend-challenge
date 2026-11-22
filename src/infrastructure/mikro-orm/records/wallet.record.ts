import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/**
 * Persistence record of a wallet: a row, not the domain aggregate. Repositories convert it with
 * `Wallet.rehydrate`. Amounts are decimal strings (`NUMERIC(20,2)`), never numbers.
 */
export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary().columnType("uuid"),
    playerId: p.text().columnType("text"),
    currency: p.string().columnType("char(3)"),
    balance: p.decimal("string").columnType("numeric(20,2)"),
    version: p.integer().columnType("integer"),
    createdAt: p.datetime().columnType("timestamptz"),
    updatedAt: p.datetime().columnType("timestamptz"),
  },
  uniques: [
    { name: "wallets_player_id_currency_unique", properties: ["playerId", "currency"] },
    { name: "wallets_id_currency_unique", properties: ["id", "currency"] },
  ],
});

export type WalletRow = InferEntity<typeof WalletRecord>;
