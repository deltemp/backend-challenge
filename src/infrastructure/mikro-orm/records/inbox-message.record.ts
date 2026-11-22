import { defineEntity, type InferEntity, p } from "@mikro-orm/core";

/** A consumed queue message, keyed by consumer and message id: a redelivery has no effect. */
export const InboxMessageRecord = defineEntity({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.text().primary().columnType("text"),
    messageId: p.text().primary().columnType("text"),
    payloadHash: p.string().columnType("char(64)"),
    receivedAt: p.datetime().columnType("timestamptz"),
    processedAt: p.datetime().columnType("timestamptz").nullable(),
  },
  primaryKeys: ["consumerName", "messageId"],
});

export type InboxMessageRow = InferEntity<typeof InboxMessageRecord>;
