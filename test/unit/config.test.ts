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
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
    });
    expect(config.wagering).toEqual({
      referenceTtlMs: 900_000,
      referenceRetry: { baseMs: 1000, capMs: 60_000 },
      outboxRetry: { baseMs: 1000, capMs: 60_000 },
    });
    expect(config.http).toEqual({ bodyLimitBytes: 16_384 });
    expect(config.consumer).toEqual({
      receiveWaitSeconds: 20,
      visibilityTimeoutSeconds: 30,
      batchSize: 10,
      retry: { baseMs: 5000, capMs: 60_000 },
      ackDelayMs: 0,
    });
    expect(config.outbox).toEqual({
      batchSize: 10,
      pollIntervalMs: 500,
      publishTimeoutMs: 5000,
      alertAttempts: 10,
    });
    expect(config.referenceRetry).toEqual({ batchSize: 50, pollIntervalMs: 1000 });
    expect(config.outageBackoff).toEqual({ baseMs: 1000, capMs: 30_000 });
    expect(config.tracing).toEqual({
      endpoint: undefined,
      serviceName: "wagering-processor",
      sampleRatio: 1,
      exportDelayMs: 5000,
    });
  });

  test("turns tracing on with an http(s) collector URL, and refuses any other", () => {
    const config = loadConfig({
      ...MINIMAL,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-lgtm:4318",
      TRACING_SAMPLE_RATIO: "0.25",
    });

    expect(config.tracing).toMatchObject({ endpoint: "http://otel-lgtm:4318", sampleRatio: 0.25 });
    for (const endpoint of ["otel-lgtm:4318", "grpc://otel-lgtm:4317"]) {
      expect(configError({ ...MINIMAL, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).message).toContain(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      );
    }
  });

  test("bounds the sample ratio between 0 and 1", () => {
    for (const ratio of ["-0.1", "1.5", "half"]) {
      expect(configError({ ...MINIMAL, TRACING_SAMPLE_RATIO: ratio }).message).toContain(
        "TRACING_SAMPLE_RATIO",
      );
    }
    expect(loadConfig({ ...MINIMAL, TRACING_SAMPLE_RATIO: "0" }).tracing.sampleRatio).toBe(0);
  });

  test("rejects a consumer or outage backoff cap below its base", () => {
    const message = configError({
      ...MINIMAL,
      SQS_RETRY_BASE_MS: "5000",
      SQS_RETRY_CAP_MS: "1000",
      OUTAGE_BACKOFF_BASE_MS: "2000",
      OUTAGE_BACKOFF_CAP_MS: "1000",
    }).message;

    expect(message).toContain("SQS_RETRY_CAP_MS");
    expect(message).toContain("OUTAGE_BACKOFF_CAP_MS");
  });

  test("accepts the acknowledgement delay, a test seam, only under NODE_ENV=test", () => {
    expect(configError({ ...MINIMAL, TEST_CONSUMER_ACK_DELAY_MS: "1000" }).message).toContain(
      "TEST_CONSUMER_ACK_DELAY_MS",
    );
    expect(
      configError({ ...MINIMAL, NODE_ENV: "production", TEST_CONSUMER_ACK_DELAY_MS: "1000" })
        .message,
    ).toContain("TEST_CONSUMER_ACK_DELAY_MS");
    expect(
      loadConfig({ ...MINIMAL, NODE_ENV: "test", TEST_CONSUMER_ACK_DELAY_MS: "1000" }).consumer
        .ackDelayMs,
    ).toBe(1000);
  });

  test("refuses an outbox round that could outlast the idle-in-transaction limit", () => {
    // Ten SendMessageBatch calls of up to 5 s plus a 3 s connection each: 80 s against 30 s.
    expect(configError({ ...MINIMAL, OUTBOX_BATCH_SIZE: "100" }).message).toContain(
      "OUTBOX_PUBLISH_TIMEOUT_MS",
    );
    expect(
      loadConfig({
        ...MINIMAL,
        OUTBOX_BATCH_SIZE: "100",
        OUTBOX_PUBLISH_TIMEOUT_MS: "1000",
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "60000",
      }).outbox.batchSize,
    ).toBe(100);
  });

  test("requires the visibility timeout to outlast the long poll", () => {
    expect(
      configError({
        ...MINIMAL,
        SQS_RECEIVE_WAIT_SECONDS: "20",
        SQS_VISIBILITY_TIMEOUT_SECONDS: "20",
      }).message,
    ).toContain("SQS_VISIBILITY_TIMEOUT_SECONDS");
    expect(
      loadConfig({
        ...MINIMAL,
        SQS_RECEIVE_WAIT_SECONDS: "1",
        SQS_VISIBILITY_TIMEOUT_SECONDS: "2",
      }).consumer.visibilityTimeoutSeconds,
    ).toBe(2);
  });

  test("bounds a receive's long poll by the 20 seconds SQS allows", () => {
    expect(configError({ ...MINIMAL, SQS_RECEIVE_WAIT_SECONDS: "21" }).message).toContain(
      "SQS_RECEIVE_WAIT_SECONDS",
    );
  });

  test("rejects a lock timeout that is not below the statement timeout", () => {
    const message = configError({
      ...MINIMAL,
      DATABASE_LOCK_TIMEOUT_MS: "5000",
      DATABASE_STATEMENT_TIMEOUT_MS: "5000",
    }).message;

    expect(message).toContain("DATABASE_LOCK_TIMEOUT_MS");
  });

  test("rejects a retry cap below its base", () => {
    const message = configError({
      ...MINIMAL,
      OUTBOX_RETRY_BASE_MS: "5000",
      OUTBOX_RETRY_CAP_MS: "1000",
    }).message;

    expect(message).toContain("OUTBOX_RETRY_CAP_MS");
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
