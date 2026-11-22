import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { withMigrationOrm } from "../../src/infrastructure/mikro-orm/migrations";
import { cleanUp } from "../support/cleanup";
import { createEmptyDatabase, type TestDatabase, testDatabaseConfig } from "../support/databases";

// Every object a migration can leave behind, not only tables, with its definition: the schema
// guarantees of this project live in functions, triggers, types and constraints, and a down()
// that restores a function by name but not its body would break the migration before it.
// Function bodies are compared without whitespace, so a reformatted copy still matches.
// MikroORM's own bookkeeping table is excluded.
const SCHEMA_FINGERPRINT = `
  SELECT 'relation ' || c.relkind::text || ' ' || c.relname AS object
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname NOT LIKE 'mikro\\_orm\\_migrations%'
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
      || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
      || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0
      AND NOT a.attisdropped AND c.relname NOT LIKE 'mikro\\_orm\\_migrations%'
  UNION ALL
  SELECT 'index ' || pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname NOT LIKE 'mikro\\_orm\\_migrations%'
  UNION ALL
  SELECT 'type ' || t.typtype::text || ' ' || t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('d', 'e', 'r', 'm')
  UNION ALL
  SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
      || md5(regexp_replace(p.prosrc, '\\s+', '', 'g'))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'trigger ' || pg_get_triggerdef(tg.oid)
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
  UNION ALL
  SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' '
      || pg_get_constraintdef(con.oid)
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

// Covers every migration in the repository, including those added later, one step at a time:
// each one must apply, revert exactly what it applied (leaving the schema the migration before
// it built), and apply again to the same schema.
describe("migrations", () => {
  let database: TestDatabase | undefined;

  beforeAll(async () => {
    database = await createEmptyDatabase();
  });

  afterAll(() => cleanUp(() => database?.drop()));

  test("each migration applies, reverts exactly what it applied, and re-applies identically", async () => {
    if (database === undefined) {
      throw new Error("setup did not complete");
    }
    await withMigrationOrm(testDatabaseConfig(database.url), async (orm) => {
      const names = (await orm.migrator.getPending()).map((migration) => migration.name);
      expect(names.length).toBeGreaterThan(0);
      // after[i]: the schema once the first i migrations are applied.
      const after = [await schemaFingerprint(orm)];
      for (const name of names) {
        await orm.migrator.up({ migrations: [name] });
        after.push(await schemaFingerprint(orm));
      }
      expect(await orm.migrator.getPending()).toEqual([]);

      for (let applied = names.length; applied > 0; applied -= 1) {
        const reverted = await orm.migrator.down();
        expect(reverted.map((migration) => migration.name)).toEqual(
          names.slice(applied - 1, applied),
        );
        expect(await schemaFingerprint(orm)).toEqual(after[applied - 1] ?? []);
      }
      expect(await orm.migrator.getExecuted()).toEqual([]);

      await orm.migrator.up();
      const reapplied = (await orm.migrator.getExecuted()).map((migration) => migration.name);
      expect(reapplied).toEqual(names);
      expect(await schemaFingerprint(orm)).toEqual(after[names.length] ?? []);
    });
  });
});
