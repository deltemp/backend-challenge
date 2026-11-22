// Migration commands, run with Bun so TypeScript migration files load natively.
//
//   bun scripts/migrations.ts create [--blank] [--name=<name>]   new migration from the schema diff
//   bun scripts/migrations.ts up                                  apply every pending migration
//   bun scripts/migrations.ts down                                revert the last migration
//   bun scripts/migrations.ts pending                             list pending migrations

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/infrastructure/config/config";
import { withMigrationOrm } from "../src/infrastructure/mikro-orm/migrations";
import { MIGRATIONS_DIRECTORY } from "../src/infrastructure/mikro-orm/mikro-orm.config";

const BIOME = join(import.meta.dirname, "..", "node_modules", "@biomejs", "biome", "bin", "biome");

/** Generated migrations use the ORM's own style; bring them in line with the repository's. */
function formatGeneratedFile(fileName: string): void {
  if (existsSync(BIOME)) {
    Bun.spawnSync(
      [process.execPath, BIOME, "format", "--write", join(MIGRATIONS_DIRECTORY, fileName)],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
  }
}

const USAGE =
  "usage: bun scripts/migrations.ts <create [--blank] [--name=<name>] | up | down | pending>";

const [command, ...args] = process.argv.slice(2);

let databaseConfig: ReturnType<typeof loadConfig>["database"];
try {
  databaseConfig = loadConfig(process.env).database;
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

await withMigrationOrm(databaseConfig, async (orm) => {
  switch (command) {
    case "create": {
      const blank = args.includes("--blank");
      const name = args.find((arg) => arg.startsWith("--name="))?.slice("--name=".length);
      const result = await orm.migrator.create(undefined, blank, false, name);
      if (result.fileName) {
        formatGeneratedFile(result.fileName);
      }
      console.log(
        result.fileName
          ? `created ${result.fileName}: review the generated SQL before applying it`
          : "no schema changes to migrate (use --blank for a hand-written migration)",
      );
      break;
    }
    case "up": {
      const applied = await orm.migrator.up();
      console.log(applied.length ? `applied ${applied.length} migration(s)` : "nothing to apply");
      break;
    }
    case "down": {
      const reverted = await orm.migrator.down();
      console.log(reverted.length ? `reverted ${reverted[0]?.name}` : "nothing to revert");
      break;
    }
    case "pending": {
      const pending = await orm.migrator.getPending();
      console.log(pending.length ? pending.map((m) => m.name).join("\n") : "no pending migrations");
      break;
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
});
