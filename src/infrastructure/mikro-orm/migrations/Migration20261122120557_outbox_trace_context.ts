import { Migration } from "@mikro-orm/migrations";

// Outbox events record the trace context of the transaction that wrote them: the W3C headers, or
// null when that transaction was not traced. The publisher sends each event with them, so the
// consumers of wager-events continue the trace of the request or message that caused it.
//
// The context belongs to the event, so the guard freezes it with the other event columns: the
// function below is the initial one with trace_context added to them.

const EVENT_COLUMNS = [
  "id",
  "sequence_number",
  "aggregate_id",
  "ordering_key",
  "event_type",
  "payload",
  "occurred_at",
] as const;

function outboxGuard(frozen: readonly string[]): string {
  const row = (prefix: "new" | "old") => frozen.map((column) => `${prefix}.${column}`).join(", ");
  return `create or replace function outbox_messages_guard() returns trigger language plpgsql as $$
  begin
    if tg_op = 'TRUNCATE' then
      raise exception 'outbox messages cannot be truncated: unpublished events would be lost'
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_never_lost',
          table = tg_table_name;
    end if;
    if tg_op = 'DELETE' then
      if old.published_at is null then
        raise exception 'event % has not been published and cannot be deleted', old.id
          using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_never_lost',
            table = tg_table_name;
      end if;
      return old;
    end if;
    if old.published_at is not null then
      raise exception 'event % was already published', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_published_final',
          table = tg_table_name;
    end if;
    -- sequence_number too: SET sequence_number = DEFAULT would draw a new value and move the
    -- event behind later events of its wallet.
    if (${row("new")}) is distinct from (${row("old")}) then
      raise exception 'event % never changes, only its publication schedule', old.id
        using errcode = 'integrity_constraint_violation', constraint = 'outbox_messages_event_immutable',
          table = tg_table_name;
    end if;
    if new.attempts < old.attempts then
      raise exception 'the attempts of event % never decrease', old.id
        using errcode = 'integrity_constraint_violation',
          constraint = 'outbox_messages_attempts_monotonic', table = tg_table_name;
    end if;
    return new;
  end;
  $$`;
}

export class Migration20261122120557_outbox_trace_context extends Migration {
  override name = "Migration20261122120557_outbox_trace_context";

  override up(): void {
    this.addSql("alter table outbox_messages add column trace_context jsonb null");
    this.addSql(
      `alter table outbox_messages add constraint outbox_messages_trace_context_check
        check (trace_context is null or jsonb_typeof(trace_context) = 'object')`,
    );
    this.addSql(
      `comment on column outbox_messages.trace_context is 'W3C trace context headers of the transaction that wrote the event; null when it was not traced'`,
    );
    this.addSql(outboxGuard([...EVENT_COLUMNS, "trace_context"]));
  }

  override down(): void {
    this.addSql(outboxGuard(EVENT_COLUMNS));
    this.addSql("alter table outbox_messages drop constraint outbox_messages_trace_context_check");
    this.addSql("alter table outbox_messages drop column trace_context");
  }
}
