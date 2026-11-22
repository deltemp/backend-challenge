import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";

const INSTANCES = 3;
const REQUESTS_PER_INSTANCE = 10;

// Proves the multi-instance harness: real OS processes sharing one database and one queue set,
// the setup every concurrency scenario of §13 builds on.
describe("multiple instances", () => {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let apps: AppProcess[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    const environment = appEnvironment(database, queues);
    // Keep every instance that did start, so afterAll stops it even if another failed.
    const started = await Promise.allSettled(
      Array.from({ length: INSTANCES }, () => startApp(environment)),
    );
    apps = started.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failure = started.find((result) => result.status === "rejected");
    if (failure !== undefined) {
      throw failure.reason;
    }
    await Promise.all(apps.map((app) => app.waitUntilReady()));
  });

  afterAll(() =>
    cleanUp(
      () => Promise.all(apps.map((app) => app.stop())),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  test("three processes share one database and queue set and serve concurrent traffic", async () => {
    expect(new Set(apps.map((app) => app.pid)).size).toBe(INSTANCES);

    const responses = await Promise.all(
      apps.flatMap((app) =>
        Array.from({ length: REQUESTS_PER_INSTANCE }, () => fetch(`${app.baseUrl}/health/ready`)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array(INSTANCES * REQUESTS_PER_INSTANCE).fill(200),
    );
  });

  test("an instance killed abruptly leaves the others serving", async () => {
    const [victim, ...survivors] = apps;
    if (victim === undefined) {
      throw new Error("no instance started");
    }

    await victim.stop("SIGKILL");

    for (const survivor of survivors) {
      const response = await fetch(`${survivor.baseUrl}/health/ready`);
      expect(response.status).toBe(200);
    }
  });
});
