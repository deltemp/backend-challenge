import { z } from "zod";
import type { BackoffSettings, WageringSettings } from "../../application/policies";
import { SQS_CONNECTION_TIMEOUT_MS, SQS_MAX_BATCH_ENTRIES } from "../sqs/limits";

export const APP_ROLES = ["api", "consumer", "outbox", "retry"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const roleList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0),
  )
  .pipe(z.array(z.enum(APP_ROLES)).min(1, "must list at least one role"))
  .transform((roles) => [...new Set(roles)]);

const fifoQueueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, "must be a FIFO queue name ending in .fifo");

const integer = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: integer(0, 65_535).default(3000),
    APP_ROLES: roleList.prefault(APP_ROLES.join(",")),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    SHUTDOWN_TIMEOUT_MS: integer(1000, 120_000).default(10_000),
    HEALTH_CHECK_TIMEOUT_MS: integer(100, 30_000).default(2000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgresql:// URL" }),
    DATABASE_POOL_MAX: integer(1, 100).default(10),
    DATABASE_CONNECT_TIMEOUT_MS: integer(100, 60_000).default(5000),
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: integer(1000, 600_000).default(30_000),
    DATABASE_LOCK_TIMEOUT_MS: integer(50, 60_000).default(2000),
    DATABASE_STATEMENT_TIMEOUT_MS: integer(100, 600_000).default(5000),
    REFERENCE_TTL_MS: integer(1, 86_400_000).default(900_000),
    REFERENCE_RETRY_BASE_MS: integer(1, 3_600_000).default(1000),
    REFERENCE_RETRY_CAP_MS: integer(1, 3_600_000).default(60_000),
    OUTBOX_RETRY_BASE_MS: integer(1, 3_600_000).default(1000),
    OUTBOX_RETRY_CAP_MS: integer(1, 3_600_000).default(60_000),
    AWS_REGION: z.string().min(1).default("us-east-1"),
    AWS_ENDPOINT_URL: z
      .url({ protocol: /^https?$/, error: "must be an http(s):// URL" })
      .optional(),
    SQS_WAGER_TRANSACTIONS_QUEUE: fifoQueueName.default("wager-transactions.fifo"),
    SQS_WAGER_TRANSACTIONS_DLQ: fifoQueueName.default("wager-transactions-dlq.fifo"),
    SQS_WAGER_EVENTS_QUEUE: fifoQueueName.default("wager-events.fifo"),
    SQS_MAX_RECEIVE_COUNT: integer(1, 1000).default(5),
    HTTP_BODY_LIMIT_BYTES: integer(1024, 1_048_576).default(16_384),
    SQS_RECEIVE_WAIT_SECONDS: integer(0, 20).default(20),
    SQS_VISIBILITY_TIMEOUT_SECONDS: integer(1, 43_200).default(30),
    SQS_RECEIVE_BATCH_SIZE: integer(1, 10).default(10),
    SQS_RETRY_BASE_MS: integer(1, 3_600_000).default(5000),
    SQS_RETRY_CAP_MS: integer(1, 3_600_000).default(60_000),
    OUTBOX_BATCH_SIZE: integer(1, 100).default(10),
    OUTBOX_POLL_INTERVAL_MS: integer(10, 60_000).default(500),
    OUTBOX_PUBLISH_TIMEOUT_MS: integer(100, 60_000).default(5000),
    OUTBOX_ALERT_ATTEMPTS: integer(1, 1_000_000).default(10),
    REFERENCE_RETRY_BATCH_SIZE: integer(1, 1000).default(50),
    REFERENCE_RETRY_POLL_INTERVAL_MS: integer(10, 60_000).default(1000),
    OUTAGE_BACKOFF_BASE_MS: integer(1, 3_600_000).default(1000),
    OUTAGE_BACKOFF_CAP_MS: integer(1, 3_600_000).default(30_000),
    TEST_CONSUMER_ACK_DELAY_MS: integer(0, 60_000).default(0),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .url({ protocol: /^https?$/, error: "must be an http(s):// URL" })
      .optional(),
    OTEL_SERVICE_NAME: z.string().min(1).max(100).default("wagering-processor"),
    TRACING_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),
    TRACING_EXPORT_DELAY_MS: integer(10, 60_000).default(5000),
  })
  .superRefine((env, context) => {
    const backoffs = [
      ["REFERENCE_RETRY_BASE_MS", "REFERENCE_RETRY_CAP_MS"],
      ["OUTBOX_RETRY_BASE_MS", "OUTBOX_RETRY_CAP_MS"],
      ["SQS_RETRY_BASE_MS", "SQS_RETRY_CAP_MS"],
      ["OUTAGE_BACKOFF_BASE_MS", "OUTAGE_BACKOFF_CAP_MS"],
    ] as const;
    for (const [base, cap] of backoffs) {
      if (env[cap] < env[base]) {
        context.addIssue({ code: "custom", path: [cap], message: `must be at least ${base}` });
      }
    }
    // Otherwise a long lock wait ends as a statement timeout: DEPENDENCY_UNAVAILABLE instead
    // of WALLET_BUSY, and missed by the lock-conflict metric.
    if (env.DATABASE_LOCK_TIMEOUT_MS >= env.DATABASE_STATEMENT_TIMEOUT_MS) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_LOCK_TIMEOUT_MS"],
        message: "must be below DATABASE_STATEMENT_TIMEOUT_MS",
      });
    }
    // A message that met an outage keeps the visibility timeout of its receive, so no long poll
    // opened before the outage can return it again: the timeout must outlast the long poll.
    if (env.SQS_VISIBILITY_TIMEOUT_SECONDS <= env.SQS_RECEIVE_WAIT_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["SQS_VISIBILITY_TIMEOUT_SECONDS"],
        message: "must be above SQS_RECEIVE_WAIT_SECONDS",
      });
    }
    // A publishing round keeps its SQL transaction open across its SendMessageBatch calls, one
    // per ten events, each bounded by the publish timeout plus the connection timeout. Past the
    // idle-in-transaction limit PostgreSQL would end the session mid-round, every round.
    const publishCalls = Math.ceil(env.OUTBOX_BATCH_SIZE / SQS_MAX_BATCH_ENTRIES);
    if (
      publishCalls * (env.OUTBOX_PUBLISH_TIMEOUT_MS + SQS_CONNECTION_TIMEOUT_MS) >=
      env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["OUTBOX_PUBLISH_TIMEOUT_MS"],
        message:
          "with OUTBOX_BATCH_SIZE, a publishing round could outlast DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS",
      });
    }
    // A test seam: holding a message between its commit and its acknowledgement lets a test kill
    // the process at that exact point. It has no place anywhere else.
    if (env.TEST_CONSUMER_ACK_DELAY_MS > 0 && env.NODE_ENV !== "test") {
      context.addIssue({
        code: "custom",
        path: ["TEST_CONSUMER_ACK_DELAY_MS"],
        message: "is only accepted with NODE_ENV=test",
      });
    }
  });

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  /** Longest wait for a connection, so an unreachable database fails fast as a transient error. */
  readonly connectTimeoutMs: number;
  /**
   * PostgreSQL ends a session that sits idle inside a transaction for longer than this, which
   * releases the row locks of a process that stalled or vanished mid-transaction.
   */
  readonly idleInTransactionTimeoutMs: number;
  /**
   * Longest wait for a row lock in the application's sessions; a timeout is a transient error
   * (`WALLET_BUSY`). Migrations run without it.
   */
  readonly lockTimeoutMs: number;
  /** Longest statement in the application's sessions (`DEPENDENCY_UNAVAILABLE`). */
  readonly statementTimeoutMs: number;
}

export interface AwsConfig {
  readonly region: string;
  /** Custom endpoint (LocalStack). Undefined means the real AWS endpoint for the region. */
  readonly endpointUrl: string | undefined;
}

export interface QueueNames {
  readonly wagerTransactions: string;
  readonly wagerTransactionsDlq: string;
  readonly wagerEvents: string;
}

export interface SqsConfig {
  readonly queues: QueueNames;
  readonly maxReceiveCount: number;
}

export interface HttpConfig {
  /** Larger bodies are refused with 413 before any parsing. */
  readonly bodyLimitBytes: number;
}

export interface ConsumerConfig {
  /** Long poll of each receive; shutdown aborts it. */
  readonly receiveWaitSeconds: number;
  /** Set on each receive; it must outlast the processing of a message. */
  readonly visibilityTimeoutSeconds: number;
  readonly batchSize: number;
  /** Pacing of a message that failed transiently, applied to its visibility timeout. */
  readonly retry: BackoffSettings;
  /** Test seam (NODE_ENV=test only): a pause between the commit and the acknowledgement. */
  readonly ackDelayMs: number;
}

export interface OutboxWorkerConfig {
  /** Events claimed per round, at most one per wallet. */
  readonly batchSize: number;
  /** Wait after a round that found less than a full batch. */
  readonly pollIntervalMs: number;
  /** Request timeout of the publisher's own SQS client, which makes a single attempt. */
  readonly publishTimeoutMs: number;
  /** Attempts from which a pending event counts in the alert gauge. */
  readonly alertAttempts: number;
}

export interface ReferenceRetryWorkerConfig {
  readonly batchSize: number;
  /** Wait after a round with nothing due, or that only met busy wallets. */
  readonly pollIntervalMs: number;
}

export interface TracingConfig {
  /** OTLP/HTTP collector base URL. Undefined turns tracing off: the API stays a no-op. */
  readonly endpoint: string | undefined;
  readonly serviceName: string;
  /** Share of new traces recorded; a caller's sampling decision is followed. */
  readonly sampleRatio: number;
  /** Delay between two span exports. */
  readonly exportDelayMs: number;
}

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly roles: readonly AppRole[];
  readonly logLevel: LogLevel;
  readonly shutdownTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly database: DatabaseConfig;
  readonly aws: AwsConfig;
  readonly sqs: SqsConfig;
  readonly wagering: WageringSettings;
  readonly http: HttpConfig;
  readonly consumer: ConsumerConfig;
  readonly outbox: OutboxWorkerConfig;
  readonly referenceRetry: ReferenceRetryWorkerConfig;
  /** Pacing of the background loops while PostgreSQL or SQS is unavailable. */
  readonly outageBackoff: BackoffSettings;
  readonly tracing: TracingConfig;
}

/** Invalid configuration. The message names each variable and the rule it breaks, never its value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

// Color switches only change how MikroORM prints its own log lines. MikroORM also writes
// MIKRO_ORM_COLORS into process.env itself, as soon as DatabaseModule is declared.
const COSMETIC_ORM_VARIABLES = new Set(["MIKRO_ORM_COLORS", "MIKRO_ORM_NO_COLOR"]);

/**
 * MikroORM merges any MIKRO_ORM_* variable into its options, around this validation: one can
 * point the application at another database, or log every SQL statement with its values.
 * Refuses to start when any is set. Reports names only, never values.
 */
export function assertNoOrmEnvironmentOverrides(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const overrides = Object.keys(environment).filter(
    (key) => key.startsWith("MIKRO_ORM_") && !COSMETIC_ORM_VARIABLES.has(key),
  );
  if (overrides.length > 0) {
    throw new ConfigError(
      `Invalid configuration:\n  - ${overrides.join(", ")}: MIKRO_ORM_* variables are not supported; configure the database through DATABASE_* variables`,
    );
  }
}

/**
 * Parses and validates the process environment. Unknown variables are ignored, and empty
 * values count as unset, so `KEY=` in a .env file falls back to the default.
 */
export function loadConfig(environment: Readonly<Record<string, string | undefined>>): AppConfig {
  assertNoOrmEnvironmentOverrides(environment);
  const definedValues = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = environmentSchema.safeParse(definedValues);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${problems.join("\n")}`);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    roles: env.APP_ROLES,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    aws: { region: env.AWS_REGION, endpointUrl: env.AWS_ENDPOINT_URL },
    sqs: {
      queues: {
        wagerTransactions: env.SQS_WAGER_TRANSACTIONS_QUEUE,
        wagerTransactionsDlq: env.SQS_WAGER_TRANSACTIONS_DLQ,
        wagerEvents: env.SQS_WAGER_EVENTS_QUEUE,
      },
      maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
    },
    wagering: {
      referenceTtlMs: env.REFERENCE_TTL_MS,
      referenceRetry: { baseMs: env.REFERENCE_RETRY_BASE_MS, capMs: env.REFERENCE_RETRY_CAP_MS },
      outboxRetry: { baseMs: env.OUTBOX_RETRY_BASE_MS, capMs: env.OUTBOX_RETRY_CAP_MS },
    },
    http: { bodyLimitBytes: env.HTTP_BODY_LIMIT_BYTES },
    consumer: {
      receiveWaitSeconds: env.SQS_RECEIVE_WAIT_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      batchSize: env.SQS_RECEIVE_BATCH_SIZE,
      retry: { baseMs: env.SQS_RETRY_BASE_MS, capMs: env.SQS_RETRY_CAP_MS },
      ackDelayMs: env.TEST_CONSUMER_ACK_DELAY_MS,
    },
    outbox: {
      batchSize: env.OUTBOX_BATCH_SIZE,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      publishTimeoutMs: env.OUTBOX_PUBLISH_TIMEOUT_MS,
      alertAttempts: env.OUTBOX_ALERT_ATTEMPTS,
    },
    referenceRetry: {
      batchSize: env.REFERENCE_RETRY_BATCH_SIZE,
      pollIntervalMs: env.REFERENCE_RETRY_POLL_INTERVAL_MS,
    },
    outageBackoff: { baseMs: env.OUTAGE_BACKOFF_BASE_MS, capMs: env.OUTAGE_BACKOFF_CAP_MS },
    tracing: {
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      sampleRatio: env.TRACING_SAMPLE_RATIO,
      exportDelayMs: env.TRACING_EXPORT_DELAY_MS,
    },
  };
}
