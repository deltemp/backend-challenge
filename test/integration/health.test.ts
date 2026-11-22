import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { databaseUrlFor } from "../support/infra";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";

/** Starts an extra instance for one test and always stops it. */
async function withApp<T>(
  environment: Record<string, string>,
  work: (app: AppProcess) => Promise<T>,
): Promise<T> {
  const app = await startApp(environment);
  try {
    return await work(app);
  } finally {
    await app.stop();
  }
}

describe("health and observability endpoints", () => {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let app: AppProcess;

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    app = await startApp(appEnvironment(database, queues));
    await app.waitUntilReady();
  });

  afterAll(() =>
    cleanUp(
      () => app?.stop(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  function environment(): Record<string, string> {
    if (database === undefined || queues === undefined) {
      throw new Error("setup did not complete");
    }
    return appEnvironment(database, queues);
  }

  test("liveness answers without checking any dependency", async () => {
    const response = await fetch(`${app.baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("readiness reports PostgreSQL and SQS as up", async () => {
    const response = await fetch(`${app.baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      info: { postgres: { status: "up" }, sqs: { status: "up" } },
    });
  });

  test("readiness fails while the inbound queue does not exist", async () => {
    const missingQueue = `missing-${crypto.randomUUID().slice(0, 8)}.fifo`;

    await withApp(
      { ...environment(), SQS_WAGER_TRANSACTIONS_QUEUE: missingQueue },
      async (other) => {
        const response = await fetch(`${other.baseUrl}/health/ready`);

        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          status: "error",
          info: { postgres: { status: "up" } },
          error: { sqs: { status: "down" } },
        });
      },
    );
  });

  test("never creates a database that does not exist", async () => {
    const missingDatabase = `wagering_missing_${crypto.randomUUID().slice(0, 8)}`;

    await withApp(
      { ...environment(), DATABASE_URL: databaseUrlFor(missingDatabase) },
      async (other) => {
        const response = await fetch(`${other.baseUrl}/health/ready`);
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { postgres: { status: "down" } } });
      },
    );

    const admin = new SQL(databaseUrlFor("postgres"));
    try {
      const rows: unknown[] =
        await admin`SELECT 1 FROM pg_database WHERE datname = ${missingDatabase}`;
      expect(rows).toHaveLength(0);
    } finally {
      await admin.close();
    }
  });

  test("a worker-only process still serves the management endpoints", async () => {
    await withApp({ ...environment(), APP_ROLES: "outbox" }, async (worker) => {
      await worker.waitUntilReady();

      const live = await fetch(`${worker.baseUrl}/health/live`);
      const metrics = await fetch(`${worker.baseUrl}/metrics`);

      expect(live.status).toBe(200);
      expect(metrics.status).toBe(200);
    });
  });

  test("echoes a safe correlation id and replaces an unsafe one", async () => {
    const kept = await fetch(`${app.baseUrl}/health/live`, {
      headers: { "x-correlation-id": "provider-a:txn-1" },
    });
    const replaced = await fetch(`${app.baseUrl}/health/live`, {
      headers: { "x-correlation-id": "not safe {}" },
    });

    expect(kept.headers.get("x-correlation-id")).toBe("provider-a:txn-1");
    expect(replaced.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a body the JSON parser rejects still gets a correlation id and is measured", async () => {
    const response = await fetch(`${app.baseUrl}/health/live`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": "malformed-1" },
      body: '{"amount": ',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("x-correlation-id")).toBe("malformed-1");
    const metrics = await (await fetch(`${app.baseUrl}/metrics`)).text();
    expect(metrics).toContain('method="POST",route="unmatched",status_code="400"');
  });

  test("exposes Prometheus metrics with HTTP durations by matched route", async () => {
    await fetch(`${app.baseUrl}/health/live`);
    await fetch(`${app.baseUrl}/no-such-route`);

    const response = await fetch(`${app.baseUrl}/metrics`);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain(
      'http_request_duration_seconds_count{method="GET",route="/health/live",status_code="200"}',
    );
    // An unknown path is labelled "unmatched", never with the raw path.
    expect(body).toContain('route="unmatched",status_code="404"');
    expect(body).not.toContain("no-such-route");
    expect(body).toContain("process_cpu_user_seconds_total");
  });
});
