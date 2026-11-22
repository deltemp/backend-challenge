import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { withMigrationOrm } from "../../src/infrastructure/mikro-orm/migrations";
import { cleanUp } from "../support/cleanup";
import { createEmptyDatabase, type TestDatabase, testDatabaseConfig } from "../support/databases";

// Every object a migration can leave behind, not only tables: the schema guarantees of this
// project live in functions, triggers, types and constraints. MikroORM's own bookkeeping table
// is excluded.
const SCHEMA_FINGERPRINT = `
  SELECT 'relation ' || c.relkind::text || ' ' || c.relname AS object
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname NOT LIKE 'mikro\\_orm\\_migrations%'
  UNION ALL
  SELECT 'type ' || t.typtype::text || ' ' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('d', 'e', 'r', 'm')
  UNION ALL
  SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'trigger ' || c.relname || ' ' || tg.tgname
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
  UNION ALL
  SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    WHERE n.nspname = 'public' AND conrelid::regclass::text NOT LIKE 'mikro\\_orm\\_migrations%'
  UNION ALL
  SELECT 'extension ' || extname FROM pg_extension WHERE extname <> 'plpgsql'
  UNION ALL
  SELECT 'schema ' || nspname FROM pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg\\_%'
  ORDER BY 1`;

async function schemaFingerprint(orm: MikroORM): Promise<string[]> {
  const rows: { object: string }[] = await orm.em
    .fork()
    .getConnection()
    .execute(SCHEMA_FINGERPRINT);
  return rows.map((row) => row.object);
}

// Covers every migration in the repository, including those added later: each one must apply,
// revert every object it created, and apply again to the same schema.
describe("migrations", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createEmptyDatabase();
  });

  afterAll(() => cleanUp(() => database?.drop()));

  test("every migration applies, reverts completely and re-applies identically", async () => {
    if (database === undefined) {
      throw new Error("setup did not complete");
    }
    await withMigrationOrm(testDatabaseConfig(database.url), async (orm) => {
      const empty = await schemaFingerprint(orm);

      await orm.migrator.up();
      expect(await orm.migrator.getPending()).toEqual([]);
      const applied = (await orm.migrator.getExecuted()).map((migration) => migration.name);
      const migrated = await schemaFingerprint(orm);

      await orm.migrator.down({ to: 0 });
      expect(await orm.migrator.getExecuted()).toEqual([]);
      expect(await schemaFingerprint(orm)).toEqual(empty);

      await orm.migrator.up();
      const reapplied = (await orm.migrator.getExecuted()).map((migration) => migration.name);
      expect(reapplied).toEqual(applied);
      expect(await schemaFingerprint(orm)).toEqual(migrated);
    });
  });
});
