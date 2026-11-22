import { MikroORM } from "@mikro-orm/postgresql";
import type { DatabaseConfig } from "../config/config";
import { createMikroOrmOptions } from "./mikro-orm.config";

/** Opens a short-lived ORM instance for migration work and always closes it. */
export async function withMigrationOrm<T>(
  database: DatabaseConfig,
  work: (orm: MikroORM) => Promise<T>,
): Promise<T> {
  const orm = await MikroORM.init(createMikroOrmOptions(database));
  try {
    return await work(orm);
  } finally {
    await orm.close();
  }
}

/** Applies every pending migration and returns the names of those applied. */
export function migrateToLatest(database: DatabaseConfig): Promise<string[]> {
  return withMigrationOrm(database, async (orm) =>
    (await orm.migrator.up()).map((migration) => migration.name),
  );
}
