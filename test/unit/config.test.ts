import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "../../src/infrastructure/config/config";

const MINIMAL = { DATABASE_URL: "postgresql://wagering:wagering@localhost:55432/wagering" };

function configError(environment: Record<string, string>): ConfigError {
  try {
    loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected loadConfig to reject the environment");
}

describe("loadConfig", () => {
  test("applies defaults when only DATABASE_URL is set", () => {
    const config = loadConfig(MINIMAL);

    expect(config.port).toBe(3000);
    expect(config.roles).toEqual(["api", "consumer", "outbox", "retry"]);
    expect(config.logLevel).toBe("info");
    expect(config.aws.endpointUrl).toBeUndefined();
    expect(config.sqs.queues).toEqual({
      wagerTransactions: "wager-transactions.fifo",
      wagerTransactionsDlq: "wager-transactions-dlq.fifo",
      wagerEvents: "wager-events.fifo",
    });
    expect(config.sqs.maxReceiveCount).toBe(5);
    expect(config.database).toEqual({
      url: MINIMAL.DATABASE_URL,
      poolMax: 10,
      connectTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 30_000,
    });
  });

  test("refuses MIKRO_ORM_* variables, naming them without their values", () => {
    const message = configError({ ...MINIMAL, MIKRO_ORM_DB_NAME: "other_db" }).message;

    expect(message).toContain("MIKRO_ORM_DB_NAME");
    expect(message).not.toContain("other_db");
  });

  test("tolerates MikroORM's own color switch", () => {
    expect(() => loadConfig({ ...MINIMAL, MIKRO_ORM_COLORS: "true" })).not.toThrow();
  });

  test("trims and deduplicates APP_ROLES", () => {
    const config = loadConfig({ ...MINIMAL, APP_ROLES: " api , outbox,api " });

    expect(config.roles).toEqual(["api", "outbox"]);
  });

  test("rejects an unknown role", () => {
    expect(configError({ ...MINIMAL, APP_ROLES: "api,scheduler" }).message).toContain("APP_ROLES");
  });

  test("rejects an empty role list", () => {
    expect(configError({ ...MINIMAL, APP_ROLES: " , " }).message).toContain("APP_ROLES");
  });

  test("requires DATABASE_URL", () => {
    expect(configError({}).message).toContain("DATABASE_URL");
  });

  test("rejects a database URL that is not PostgreSQL", () => {
    expect(configError({ DATABASE_URL: "mysql://localhost/wagering" }).message).toContain(
      "DATABASE_URL",
    );
  });

  test("rejects queue names that are not FIFO", () => {
    expect(configError({ ...MINIMAL, SQS_WAGER_EVENTS_QUEUE: "wager-events" }).message).toContain(
      "SQS_WAGER_EVENTS_QUEUE",
    );
  });

  test("treats empty values as unset", () => {
    const config = loadConfig({ ...MINIMAL, AWS_ENDPOINT_URL: "", PORT: "" });

    expect(config.aws.endpointUrl).toBeUndefined();
    expect(config.port).toBe(3000);
  });

  test("reports every problem at once", () => {
    const message = configError({ PORT: "70000", LOG_LEVEL: "loud" }).message;

    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("PORT");
    expect(message).toContain("LOG_LEVEL");
  });

  test("never echoes configuration values, which may be secrets", () => {
    const message = configError({ DATABASE_URL: "mysql://admin:hunter2@db.internal/x" }).message;

    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("db.internal");
  });
});
