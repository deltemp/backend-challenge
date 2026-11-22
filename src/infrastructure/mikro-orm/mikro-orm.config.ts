import { join } from "node:path";
import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import type { DatabaseConfig } from "../config/config";
import { PERSISTENCE_RECORDS } from "./records";

export const MIGRATIONS_DIRECTORY = join(import.meta.dirname, "migrations");

/**
 * Who opens the connections. The application's sessions run with the lock and statement
 * timeouts; migrations run without them, so a long DDL statement or a lock wait is not cut off.
 */
export type SessionPurpose = "application" | "migrations";

/**
 * MikroORM options shared by the application, the migration scripts and the tests.
 *
 * Persistence records (`defineEntity` schemas, never domain classes) are registered in
 * `entities`. MikroORM 7 connects lazily: nothing touches the database until the first query.
 */
export function createMikroOrmOptions(database: DatabaseConfig, purpose: SessionPurpose) {
  // Session settings, sent by the pg driver when it opens each connection.
  const timeouts =
    purpose === "application"
      ? { lock_timeout: database.lockTimeoutMs, statement_timeout: database.statementTimeoutMs }
      : {};
  return defineConfig({
    clientUrl: database.url,
    entities: PERSISTENCE_RECORDS,
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_DIRECTORY,
      pathTs: MIGRATIONS_DIRECTORY,
      glob: "!(*.d).{js,ts}",
      emit: "ts",
      // The migrator's own progress lines are plain text; the scripts report what they applied.
      silent: true,
      transactional: true,
      allOrNothing: true,
      dropTables: false,
      // The snapshot describes entity metadata only, under a fixed name, so applying migrations
      // to test databases never rewrites it.
      snapshot: true,
      snapshotName: ".snapshot",
      snapshotOnMigrate: false,
    },
    pool: { min: 0, max: database.poolMax },
    // Passed straight to the pg pool.
    driverOptions: {
      connectionTimeoutMillis: database.connectTimeoutMs,
      idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
      ...timeouts,
      keepAlive: true,
    },
    // Application processes never run DDL: databases are created by compose or the test
    // harness, and the schema only by migrations. With the default (true), the first query
    // against a missing database would CREATE it, racing between replicas.
    ensureDatabase: false,
    // Explicit, so a stray environment variable cannot enable SQL logging with bound values.
    debug: false,
    allowGlobalContext: false,
  });
}
