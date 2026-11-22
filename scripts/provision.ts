// Brings the database schema and the SQS queues up to date, then exits.
//
// docker compose runs this once, as the `provision` service, before the application replicas
// start, so several instances never race to apply the same migration. Safe to re-run.

import { ConfigError, loadConfig } from "../src/infrastructure/config/config";
import { migrateToLatest } from "../src/infrastructure/mikro-orm/migrations";
import { createLogger } from "../src/infrastructure/observability/logger";
import { provisionQueues } from "../src/infrastructure/sqs/queue-provisioning";
import { createSqsClient } from "../src/infrastructure/sqs/sqs-client";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger(config.logLevel);
const sqs = createSqsClient(config.aws);

try {
  const applied = await migrateToLatest(config.database);
  logger.info({ applied }, "database migrations applied");

  const queues = await provisionQueues(sqs, config.sqs.queues, {
    maxReceiveCount: config.sqs.maxReceiveCount,
  });
  logger.info({ queues: Object.values(config.sqs.queues), urls: queues }, "sqs queues provisioned");
} catch (error) {
  logger.fatal({ err: error }, "provisioning failed");
  process.exitCode = 1;
} finally {
  sqs.destroy();
}
