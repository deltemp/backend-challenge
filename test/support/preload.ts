// Preloaded by the integration and concurrency suites (see package.json). Checks that the
// infrastructure is up and builds the migrated template database that test files clone.

import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";
import { assertNoOrmEnvironmentOverrides } from "../../src/infrastructure/config/config";
import { withTimeout } from "../../src/infrastructure/timeout";
import { stopAllApps } from "./app-process";
import { cleanUp } from "./cleanup";
import {
  createTemplateDatabase,
  dropDatabase,
  dropStaleDatabases,
  TEMPLATE_DATABASE_VARIABLE,
} from "./databases";
import { databaseAddress, databaseUrlFor, infra } from "./infra";
import { createTestSqsClient, deleteStaleTestQueues } from "./queues";

const START_HINT =
  "Start the infrastructure first: docker compose up -d --wait postgres localstack";

// LocalStack accepts any credentials, but the AWS SDK refuses to sign requests without some.
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

let templateDatabase: string | undefined;

beforeAll(async () => {
  // The harness runs migrations itself, without loadConfig, so it repeats this check.
  assertNoOrmEnvironmentOverrides(process.env);
  await assertPostgresIsUp();
  await assertLocalStackIsUp();
  await dropStaleDatabases();
  const sqs = createTestSqsClient();
  try {
    await deleteStaleTestQueues(sqs);
  } finally {
    sqs.destroy();
  }
  templateDatabase = await createTemplateDatabase();
  process.env[TEMPLATE_DATABASE_VARIABLE] = templateDatabase;
});

afterAll(() =>
  cleanUp(
    () => stopAllApps(),
    () => (templateDatabase === undefined ? undefined : dropDatabase(templateDatabase)),
  ),
);

async function assertPostgresIsUp(): Promise<void> {
  const sql = new SQL(databaseUrlFor("postgres"));
  try {
    await withTimeout(sql`SELECT 1`.execute(), 5000);
  } catch (error) {
    throw new Error(
      `PostgreSQL is not reachable at ${databaseAddress()} (DATABASE_URL). ${START_HINT}\nCause: ${String(error)}`,
    );
  } finally {
    await sql.close();
  }
}

async function assertLocalStackIsUp(): Promise<void> {
  let sqsState: unknown;
  try {
    const response = await fetch(`${infra.awsEndpointUrl}/_localstack/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = (await response.json()) as { services?: Record<string, string> };
    sqsState = health.services?.sqs;
  } catch (error) {
    throw new Error(
      `LocalStack is not reachable at ${infra.awsEndpointUrl}. ${START_HINT}\nCause: ${String(error)}`,
    );
  }
  if (sqsState !== "available" && sqsState !== "running") {
    throw new Error(`LocalStack is up but SQS is "${String(sqsState)}". ${START_HINT}`);
  }
}
