import { Migration } from "@mikro-orm/migrations";

// The outbox claim takes the oldest due events in sequence order. Without an index on that
// order restricted to unpublished rows, PostgreSQL walks the unique index on sequence_number
// from the start, through every event ever published (they are never purged), and filters them
// out: the load test measured 240 ms per claim on an empty outbox after 187 000 publications,
// paid by every round of every publisher. This partial index holds only unpublished rows, so a
// claim reads the pending events and nothing else, however long the history grows.
//
// Built inside the migration's transaction, it blocks writes to the outbox while it reads the
// table once; on a large production table it would be built CONCURRENTLY, outside one.

export class Migration20261122141958_outbox_unpublished_sequence_index extends Migration {
  override name = "Migration20261122141958_outbox_unpublished_sequence_index";

  override up(): void {
    this.addSql(
      `create index outbox_messages_unpublished_sequence_idx
        on outbox_messages (sequence_number) where published_at is null`,
    );
  }

  override down(): void {
    this.addSql("drop index outbox_messages_unpublished_sequence_idx");
  }
}
