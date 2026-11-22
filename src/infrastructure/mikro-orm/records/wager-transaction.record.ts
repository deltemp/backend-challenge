import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/**
 * A wagering transaction and its outcome. The provider fields are null only for the internal
 * OPENING credit. PENDING is never stored: it does not outlive the SQL transaction that creates it.
 */
export const WagerTransactionRecord = defineEntity({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary().columnType("uuid"),
    providerId: p.text().columnType("text").nullable(),
    externalTransactionId: p.text().columnType("text").nullable(),
    idempotencyKey: p.text().columnType("text").nullable(),
    payloadHash: p.string().columnType("char(64)").nullable(),
    walletId: p.uuid().columnType("uuid"),
    playerId: p.text().columnType("text"),
    roundId: p.text().columnType("text").nullable(),
    gameId: p.text().columnType("text").nullable(),
    kind: p.text().columnType("text"),
    amount: p.decimal("string").columnType("numeric(20,2)"),
    currency: p.string().columnType("char(3)"),
    referenceExternalTransactionId: p.text().columnType("text").nullable(),
    status: p.text().columnType("text"),
    referenceTransactionId: p.uuid().columnType("uuid").nullable(),
    failureCode: p.text().columnType("text").nullable(),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
    observedBalance: p.decimal("string").columnType("numeric(20,2)").nullable(),
    referenceDeadline: p.datetime().columnType("timestamptz").nullable(),
    nextAttemptAt: p.datetime().columnType("timestamptz").nullable(),
    referenceAttempts: p.integer().columnType("integer").default(0),
    createdAt: p.datetime().columnType("timestamptz"),
    updatedAt: p.datetime().columnType("timestamptz"),
  },
  uniques: [
    { name: "wager_transactions_idempotency_key_unique", properties: ["idempotencyKey"] },
    {
      name: "wager_transactions_provider_external_id_unique",
      properties: ["providerId", "externalTransactionId"],
    },
  ],
});

export type WagerTransactionRow = InferEntity<typeof WagerTransactionRecord>;
