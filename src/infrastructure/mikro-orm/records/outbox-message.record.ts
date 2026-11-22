import { defineEntity, type InferEntity, type Opt, p } from "@mikro-orm/core";

/**
 * An integration event waiting to be published. `sequenceNumber` comes from a database
 * sequence at insert, under the wallet lock, so it orders the events of a wallet by commit;
 * the application never writes it.
 */
export const OutboxMessageRecord = defineEntity({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary().columnType("uuid"),
    // `Opt`: MikroORM infers optional fields from defaults, not from generated columns.
    sequenceNumber: p
      .bigint("string")
      .$type<Opt<string>>()
      .columnType("bigint")
      .generated("identity"),
    aggregateId: p.uuid().columnType("uuid"),
    orderingKey: p.uuid().columnType("uuid"),
    eventType: p.text().columnType("text"),
    payload: p.json<Record<string, unknown>>().columnType("jsonb"),
    occurredAt: p.datetime().columnType("timestamptz"),
    attempts: p.integer().columnType("integer").default(0),
    nextAttemptAt: p.datetime().columnType("timestamptz").nullable(),
    publishedAt: p.datetime().columnType("timestamptz").nullable(),
    // W3C trace context headers of the transaction that wrote the event, when it was traced.
    traceContext: p.json<Record<string, string>>().columnType("jsonb").nullable(),
  },
  uniques: [{ name: "outbox_messages_sequence_number_unique", properties: ["sequenceNumber"] }],
});

export type OutboxMessageRow = InferEntity<typeof OutboxMessageRecord>;
