import { SQL } from "bun";
import type { DatabaseConfig } from "../../src/infrastructure/config/config";
import { migrateToLatest } from "../../src/infrastructure/mikro-orm/migrations";
import { databaseUrlFor } from "./infra";

// Every test file gets its own database, cloned from a template that the preload migrates once
// per run. Names carry their creation time so leftovers from crashed runs can be recognized.
const TEST_PREFIX = "wagering_test_";
const TEMPLATE_PREFIX = "wagering_template_";
const STALE_AFTER_MS = 60 * 60 * 1000;

export const TEMPLATE_DATABASE_VARIABLE = "TEST_TEMPLATE_DATABASE";

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/** CREATE and DROP DATABASE run against the maintenance database, never the target. */
async function withAdminConnection<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(databaseUrlFor("postgres"));
  try {
    return await work(sql);
  } finally {
    await sql.close();
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function testDatabase(name: string): TestDatabase {
  return { name, url: databaseUrlFor(name), drop: () => dropDatabase(name) };
}

/** Connection settings for tests that open their own ORM instance (migrations, setup). */
export function testDatabaseConfig(url: string): DatabaseConfig {
  return { url, poolMax: 2, connectTimeoutMs: 5000, idleInTransactionTimeoutMs: 30_000 };
}

export async function createTemplateDatabase(): Promise<string> {
  const name = uniqueName(TEMPLATE_PREFIX);
  await withAdminConnection((sql) => sql.unsafe(`CREATE DATABASE "${name}"`));
  try {
    await migrateToLatest(testDatabaseConfig(databaseUrlFor(name)));
  } catch (error) {
    await dropDatabase(name);
    throw error;
  }
  return name;
}

/** A fully migrated database of its own, cloned from the run's template in a fraction of a second. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const template = process.env[TEMPLATE_DATABASE_VARIABLE];
  if (!template) {
    throw new Error(
      `${TEMPLATE_DATABASE_VARIABLE} is not set: run this file through bun run test:integration or bun run test:concurrency.`,
    );
  }
  const name = uniqueName(TEST_PREFIX);
  await withAdminConnection((sql) =>
    sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );
  return testDatabase(name);
}

/** An empty database with no migrations applied, for tests of the migrations themselves. */
export async function createEmptyDatabase(): Promise<TestDatabase> {
  const name = uniqueName(TEST_PREFIX);
  await withAdminConnection((sql) => sql.unsafe(`CREATE DATABASE "${name}"`));
  return testDatabase(name);
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdminConnection((sql) => sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/** Drops test and template databases older than an hour, left behind by interrupted runs. */
export async function dropStaleDatabases(): Promise<void> {
  const stale = await withAdminConnection(async (sql) => {
    const rows: { datname: string }[] = await sql`
      SELECT datname FROM pg_database
      WHERE datname LIKE ${`${TEST_PREFIX}%`} OR datname LIKE ${`${TEMPLATE_PREFIX}%`}`;
    return rows
      .map((row) => row.datname)
      .filter((name) => {
        const createdAt = Number.parseInt(name.split("_")[2] ?? "", 36);
        return Number.isFinite(createdAt) && Date.now() - createdAt > STALE_AFTER_MS;
      });
  });
  for (const name of stale) {
    await dropDatabase(name);
  }
}
