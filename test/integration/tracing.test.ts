import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { eventually } from "../support/eventually";
import { call, httpBody, openWalletOverHttp, submitOverHttp } from "../support/http";
import { ledgerDiscrepancies } from "../support/ledger";
import { sendMessage, takeMessages, wagerMessage } from "../support/messaging";
import {
  callerTraceContext,
  type ExportedSpan,
  type OtlpReceiver,
  parseTraceparent,
  startOtlpReceiver,
} from "../support/otlp";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { transactionCommand } from "../support/use-cases";

const SERVICE_NAME = "wagering-tracing-test";

// §12 tracing over a real process: the instance exports its spans over OTLP/HTTP to a receiver
// in the test, as it would to the collector of the observability profile. A trace starts at the
// caller (an HTTP traceparent or a message attribute), goes through the use case and its SQL
// transaction, and continues in the events the outbox publishes.

function logLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

describe("tracing", () => {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let receiver: OtlpReceiver | undefined;
  let app: AppProcess | undefined;

  function setup() {
    if (
      app === undefined ||
      database === undefined ||
      sql === undefined ||
      queues === undefined ||
      receiver === undefined
    ) {
      throw new Error("setup did not complete");
    }
    return { app, baseUrl: app.baseUrl, database, sql, queues, receiver };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    sql = new SQL(database.url);
    receiver = startOtlpReceiver();
    app = await startApp({
      ...appEnvironment(database, queues),
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
      OTEL_SERVICE_NAME: SERVICE_NAME,
      TRACING_EXPORT_DELAY_MS: "50",
      OUTBOX_POLL_INTERVAL_MS: "50",
      REFERENCE_RETRY_POLL_INTERVAL_MS: "50",
      REFERENCE_RETRY_BASE_MS: "50",
      REFERENCE_RETRY_CAP_MS: "200",
      // A held wallet lock answers WALLET_BUSY quickly.
      DATABASE_LOCK_TIMEOUT_MS: "300",
    });
    await app.waitUntilReady();
  });

  afterAll(() =>
    cleanUp(
      () => app?.stop(),
      () => receiver?.stop(),
      () => sql?.close(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  /** The events of a wallet on wager-events, in commit order: its opening's two first. */
  function eventsOf(walletId: string, expected: number) {
    return takeMessages(
      sqs,
      setup().queues.urls.wagerEvents,
      expected,
      (message) => message.Attributes?.MessageGroupId === walletId,
    );
  }

  test("an HTTP submission continues the caller's trace through the use case and its SQL transaction", async () => {
    const { app, baseUrl, receiver } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const caller = callerTraceContext();
    const command = transactionCommand(wallet, { kind: "BET" });

    const answer = await call(baseUrl, "/wagering/transactions", {
      json: httpBody(command),
      headers: { "idempotency-key": command.idempotencyKey, traceparent: caller.traceparent },
    });

    expect(answer.status).toBe(200);
    const { transactionId } = answer.body as { transactionId: string };
    const inTrace = (span: ExportedSpan) => span.traceId === caller.traceId;
    const server = await receiver.waitForSpan(
      "the server span",
      (span) => inTrace(span) && span.kind === "SERVER",
    );
    expect(server).toMatchObject({
      name: "POST /wagering/transactions",
      parentSpanId: caller.spanId,
      attributes: {
        "http.request.method": "POST",
        "http.route": "/wagering/transactions",
        "http.response.status_code": 200,
      },
      resource: { "service.name": SERVICE_NAME },
    });
    // Each process is told apart from the other replicas.
    expect(String(server.resource["service.instance.id"])).toEndWith(`/${app.pid}`);

    const submission = await receiver.waitForSpan(
      "the use-case span",
      (span) => inTrace(span) && span.name === "SubmitWagerTransaction",
    );
    expect(submission).toMatchObject({
      parentSpanId: server.spanId,
      attributes: {
        "wagering.source": "http",
        "wagering.provider_id": command.providerId,
        "wagering.wallet_id": wallet.id,
        "wagering.transaction.id": transactionId,
        "wagering.transaction.kind": "BET",
        "wagering.transaction.status": "PROCESSED",
        "wagering.idempotent_replay": false,
      },
    });
    const transaction = await receiver.waitForSpan(
      "the SQL transaction span",
      (span) => inTrace(span) && span.name === "db.transaction",
    );
    expect(transaction).toMatchObject({
      kind: "CLIENT",
      parentSpanId: submission.spanId,
      attributes: { "db.system.name": "postgresql" },
    });

    const accessLog = await eventually("the access log line of the request", async () =>
      app
        .output()
        .map(logLine)
        .find((line) => line?.msg === "http request completed" && line.traceId === caller.traceId),
    );
    expect(accessLog).toMatchObject({ route: "/wagering/transactions", statusCode: 200 });
  });

  test("the events of a traced transaction carry its trace to wager-events, sent in a producer span linked to it", async () => {
    const { baseUrl, queues, receiver } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const caller = callerTraceContext();
    const command = transactionCommand(wallet, { kind: "BET" });

    const answer = await call(baseUrl, "/wagering/transactions", {
      json: httpBody(command),
      headers: {
        "idempotency-key": command.idempotencyKey,
        traceparent: caller.traceparent,
        tracestate: "wagering=test",
      },
    });

    expect(answer.status).toBe(200);
    const transaction = await receiver.waitForSpan(
      "the SQL transaction span",
      (span) => span.traceId === caller.traceId && span.name === "db.transaction",
    );
    const [openingProcessed, openingBalance, betProcessed, betBalance] = await eventsOf(
      wallet.id,
      4,
    );
    // The events name the SQL transaction that wrote them, and keep the caller's trace state.
    for (const message of [betProcessed, betBalance]) {
      expect(parseTraceparent(message?.MessageAttributes?.traceparent?.StringValue)).toEqual({
        traceId: caller.traceId,
        spanId: transaction.spanId,
      });
      expect(message?.MessageAttributes?.tracestate?.StringValue).toBe("wagering=test");
    }
    // The wallet was opened by a request of its own, in a trace of its own.
    for (const message of [openingProcessed, openingBalance]) {
      const opening = parseTraceparent(message?.MessageAttributes?.traceparent?.StringValue);
      expect(opening).toBeDefined();
      expect(opening?.traceId).not.toBe(caller.traceId);
    }

    // Publication is a job of the outbox worker: a trace of its own, linked to the event's.
    const send = await receiver.waitForSpan(
      "the producer span",
      (span) =>
        span.kind === "PRODUCER" && span.links.some((link) => link.traceId === caller.traceId),
    );
    expect(send).toMatchObject({
      name: `send ${queues.names.wagerEvents}`,
      attributes: {
        "messaging.system": "aws_sqs",
        "messaging.destination.name": queues.names.wagerEvents,
        "messaging.operation.type": "send",
        "wagering.publication.failures": 0,
      },
    });
    expect(send.parentSpanId).toBeUndefined();
    expect(send.links).toContainEqual({ traceId: caller.traceId, spanId: transaction.spanId });
  });

  test("a message that carries a traceparent is processed in a consumer span of that trace", async () => {
    const { app, baseUrl, sql, queues, receiver } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const producer = callerTraceContext();
    const message = wagerMessage(transactionCommand(wallet, { kind: "BET" }));

    await sendMessage(sqs, queues.urls.wagerTransactions, message, {
      groupId: wallet.id,
      // No valid entry: an empty tracestate must never be stored, since SQS refuses one.
      attributes: { traceparent: producer.traceparent, tracestate: "not a tracestate" },
    });

    const inTrace = (span: ExportedSpan) => span.traceId === producer.traceId;
    const consumer = await receiver.waitForSpan(
      "the consumer span",
      (span) => inTrace(span) && span.kind === "CONSUMER",
    );
    expect(consumer).toMatchObject({
      name: `process ${queues.names.wagerTransactions}`,
      parentSpanId: producer.spanId,
      attributes: {
        "messaging.system": "aws_sqs",
        "messaging.destination.name": queues.names.wagerTransactions,
        "messaging.operation.type": "process",
        "wagering.message_id": message.messageId,
        "wagering.message.outcome": "acknowledged",
      },
    });
    const submission = await receiver.waitForSpan(
      "the use-case span",
      (span) => inTrace(span) && span.name === "SubmitWagerTransaction",
    );
    expect(submission).toMatchObject({
      parentSpanId: consumer.spanId,
      attributes: {
        "wagering.source": "sqs",
        "wagering.transaction.status": "PROCESSED",
        "wagering.duplicate_message": false,
      },
    });
    const transaction = await receiver.waitForSpan(
      "the SQL transaction span",
      (span) => inTrace(span) && span.name === "db.transaction",
    );
    expect(transaction.parentSpanId).toBe(submission.spanId);

    const processed = await eventually("the consumer's log line", async () =>
      app
        .output()
        .map(logLine)
        .find(
          (line) =>
            line?.msg === "wager transaction message processed" &&
            line.traceId === producer.traceId,
        ),
    );
    expect(processed).toMatchObject({ spanId: consumer.spanId, messageId: message.messageId });

    // The trace goes on in the events of the transaction, without the invalid trace state.
    const [, , betProcessed, betBalance] = await eventsOf(wallet.id, 4);
    for (const event of [betProcessed, betBalance]) {
      expect(parseTraceparent(event?.MessageAttributes?.traceparent?.StringValue)).toEqual({
        traceId: producer.traceId,
        spanId: transaction.spanId,
      });
      expect(event?.MessageAttributes?.tracestate).toBeUndefined();
    }
    const stored: { trace_context: Record<string, string> }[] = await sql`
      select trace_context from outbox_messages
      where ordering_key = ${wallet.id} and trace_context->>'traceparent' like ${`%${producer.traceId}%`}`;
    expect(stored.map((row) => Object.keys(row.trace_context))).toEqual([
      ["traceparent"],
      ["traceparent"],
    ]);
  });

  test("the retry worker reprocesses a parked transaction in a trace of its own", async () => {
    const { baseUrl, receiver } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const money = { amount: "25.00", currency: "BRL" };
    const refund = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, { kind: "REFUND", money, referenceExternalTransactionId: betId }),
    );
    expect(refund.status).toBe(202);
    const { transactionId } = refund.body as { transactionId: string };

    const bet = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, { kind: "BET", money, externalTransactionId: betId }),
    );

    expect(bet.status).toBe(200);
    const reprocess = await receiver.waitForSpan(
      "the reprocessing that applied the refund",
      (span) =>
        span.name === "ReprocessPendingReference" &&
        span.attributes["wagering.transaction.id"] === transactionId &&
        span.attributes["wagering.reprocess.outcome"] === "processed",
    );
    expect(reprocess.parentSpanId).toBeUndefined();
    expect(reprocess.attributes).toMatchObject({
      "wagering.source": "retry",
      "wagering.transaction.kind": "REFUND",
      "wagering.transaction.status": "PROCESSED",
    });
    const transaction = await receiver.waitForSpan(
      "its SQL transaction",
      (span) => span.traceId === reprocess.traceId && span.name === "db.transaction",
    );
    expect(transaction.parentSpanId).toBe(reprocess.spanId);
  });

  test("a busy wallet fails the submission's spans and records the exception", async () => {
    const { baseUrl, sql, receiver } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const caller = callerTraceContext();
    const command = transactionCommand(wallet, { kind: "BET" });

    // The test holds the wallet's row lock past the instance's lock timeout.
    const answer = await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      return call(baseUrl, "/wagering/transactions", {
        json: httpBody(command),
        headers: { "idempotency-key": command.idempotencyKey, traceparent: caller.traceparent },
      });
    });

    expect(answer.status).toBe(503);
    const inTrace = (span: ExportedSpan) => span.traceId === caller.traceId;
    const submission = await receiver.waitForSpan(
      "the failed use-case span",
      (span) => inTrace(span) && span.name === "SubmitWagerTransaction",
    );
    expect(submission).toMatchObject({
      statusCode: 2,
      attributes: { "error.type": "WALLET_BUSY" },
    });
    expect(submission.events).toContainEqual({
      name: "exception",
      attributes: expect.objectContaining({
        "exception.type": "WalletBusyError",
        "exception.message": "the wallet is busy: retry later",
      }),
    });
    const transaction = await receiver.waitForSpan(
      "the failed SQL transaction span",
      (span) => inTrace(span) && span.name === "db.transaction",
    );
    expect(transaction).toMatchObject({
      statusCode: 2,
      parentSpanId: submission.spanId,
      attributes: { "error.type": "WALLET_BUSY" },
    });
    const server = await receiver.waitForSpan(
      "the server span",
      (span) => inTrace(span) && span.kind === "SERVER",
    );
    expect(server).toMatchObject({
      statusCode: 2,
      attributes: { "http.response.status_code": 503 },
    });
  });

  test("a collector that fails costs the requests nothing: the instance stays up and quiet", async () => {
    const { baseUrl, database, queues } = setup();
    // Accepts each export and hangs up at once, like a collector that is not there: compose
    // runs the replicas pointed at the collector of a profile that may not be started.
    let exportAttempts = 0;
    const brokenCollector = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          exportAttempts += 1;
          socket.end();
        },
        data() {},
      },
    });
    const unlucky = await startApp({
      ...appEnvironment(database, queues),
      APP_ROLES: "api",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${brokenCollector.port}`,
      TRACING_EXPORT_DELAY_MS: "10",
    });
    try {
      await unlucky.waitUntilReady();
      await openWalletOverHttp(unlucky.baseUrl, "100.00");

      await eventually("failed exports", async () => (exportAttempts >= 2 ? true : undefined));

      const wallet = await openWalletOverHttp(unlucky.baseUrl, "100.00");
      expect((await call(unlucky.baseUrl, `/wallets/${wallet.id}`)).status).toBe(200);
      expect((await fetch(`${unlucky.baseUrl}/health/live`)).status).toBe(200);
      const errors = unlucky
        .output()
        .map(logLine)
        .filter((line) => line?.level === "error" || line?.level === "fatal");
      expect(errors).toEqual([]);
    } finally {
      await unlucky.stop("SIGKILL");
      brokenCollector.stop(true);
    }
    // The instance under test is unaffected.
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });

  test("probes and scrapes are not traced, and no span carries an amount", async () => {
    const { baseUrl, receiver } = setup();
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(200);
    // A traced request after them: spans are exported in the order they end, so once its span
    // arrived, a span of the probes would have arrived too.
    const marker = callerTraceContext();
    const lookup = await fetch(`${baseUrl}/wallets/${Bun.randomUUIDv7()}`, {
      headers: { traceparent: marker.traceparent },
    });
    expect(lookup.status).toBe(404);
    await receiver.waitForSpan("the marker request", (span) => span.traceId === marker.traceId);

    const spans = receiver.spans();
    const probes = spans.filter((span) =>
      /^\/(health|metrics)/.test(String(span.attributes["url.path"] ?? "")),
    );
    expect(probes).toEqual([]);
    // Every amount these tests sent or held, in any attribute of a span or of its events (the
    // recorded exceptions, with their messages and stack traces, included).
    const amounts = ["100.00", "10.00", "25.00", "90.00", "75.00"];
    const attributes = spans.flatMap((span) => [
      ...Object.entries(span.attributes),
      ...span.events.flatMap((event) => Object.entries(event.attributes)),
    ]);
    expect(spans.some((span) => span.events.some((event) => event.name === "exception"))).toBe(
      true,
    );
    for (const [key, value] of attributes) {
      expect(key).not.toMatch(/amount|balance|money/i);
      for (const amount of amounts) {
        expect(String(value)).not.toContain(amount);
      }
    }
  });
});
