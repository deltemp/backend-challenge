import { afterEach, describe, expect, test } from "bun:test";
import { PostgreSqlPlatform } from "@mikro-orm/postgresql";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { IdempotencyConflictError, WalletBusyError } from "../../src/application/errors";
import { createLogger } from "../../src/infrastructure/observability/logger";
import {
  activeTraceContext,
  contextFrom,
  hasActiveSpan,
  inSpan,
  linkFrom,
  startTracing,
} from "../../src/infrastructure/observability/tracing";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

/** Registers what `startTracing` registers, with the spans kept in memory instead of exported. */
function traceInMemory(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
  return exporter;
}

function onlySpan(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) {
    throw new Error("no span was finished");
  }
  return span;
}

function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

afterEach(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

describe("tracing off", () => {
  test("without an endpoint nothing is registered: spans cost nothing and nothing propagates", async () => {
    const tracing = startTracing({
      endpoint: undefined,
      serviceName: "test",
      sampleRatio: 1,
      exportDelayMs: 100,
    });

    const result = await inSpan("work", {}, async (span) => {
      expect(span.isRecording()).toBe(false);
      expect(hasActiveSpan()).toBe(false);
      expect(activeTraceContext()).toEqual({});
      return "done";
    });

    expect(result).toBe("done");
    expect(linkFrom({ traceparent: TRACEPARENT })).toBeUndefined();
    await tracing.shutdown();
  });
});

describe("spans", () => {
  test("a span opened inside another is its child, and both end", async () => {
    const exporter = traceInMemory();

    await inSpan("outer", {}, async () => {
      expect(hasActiveSpan()).toBe(true);
      await inSpan("inner", { kind: SpanKind.CLIENT }, async () => undefined);
    });

    const spans = exporter.getFinishedSpans();
    const outer = spans.find((span) => span.name === "outer");
    const inner = spans.find((span) => span.name === "inner");
    expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId ?? "missing");
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId ?? "missing");
    expect(inner?.kind).toBe(SpanKind.CLIENT);
  });

  test("a log line written inside a span names its trace and span", async () => {
    traceInMemory();
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger("info", {
      write: (line: string) => {
        lines.push(JSON.parse(line));
      },
    });

    logger.info("outside");
    const ids = await inSpan("work", {}, async (span) => {
      logger.info("inside");
      return span.spanContext();
    });

    expect(lines[0]).not.toHaveProperty("traceId");
    expect(lines[1]).toMatchObject({ msg: "inside", traceId: ids.traceId, spanId: ids.spanId });
  });
});

describe("trace context in message headers", () => {
  test("the active span travels as a W3C traceparent and comes back as a link", async () => {
    traceInMemory();

    await inSpan("producer", {}, async (span) => {
      const { traceId, spanId } = span.spanContext();
      const headers = activeTraceContext();

      expect(headers).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
      expect(trace.getSpanContext(contextFrom(headers))).toMatchObject({
        traceId,
        spanId,
        isRemote: true,
      });
      expect(linkFrom(headers)?.context).toMatchObject({ traceId, spanId });
    });
  });

  test("a valid tracestate travels on; one without a valid entry is dropped, never sent empty", async () => {
    traceInMemory();
    const headersUnder = (tracestate: string) =>
      inSpan(
        "consumer",
        {},
        async () => activeTraceContext(),
        contextFrom({ traceparent: TRACEPARENT, tracestate }),
      );

    expect(await headersUnder("vendor=value")).toMatchObject({ tracestate: "vendor=value" });
    expect(Object.keys(await headersUnder("not a tracestate"))).toEqual(["traceparent"]);
  });

  test("headers without a valid traceparent give no link", () => {
    traceInMemory();

    expect(linkFrom({})).toBeUndefined();
    expect(linkFrom({ traceparent: "not-a-traceparent" })).toBeUndefined();
    expect(linkFrom({ traceparent: `00-${"0".repeat(32)}-${SPAN_ID}-01` })).toBeUndefined();
  });

  test("a span started from the headers continues their trace", async () => {
    const exporter = traceInMemory();

    await inSpan(
      "consumer",
      { kind: SpanKind.CONSUMER },
      async () => undefined,
      contextFrom({
        traceparent: TRACEPARENT,
      }),
    );

    const span = onlySpan(exporter);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
  });
});

describe("failures", () => {
  test("a bug fails the span with its code, and the row values of a database error stay out", async () => {
    const exporter = traceInMemory();
    // MikroORM appends the error's detail, which carries the row, to the message.
    const failure = new PostgreSqlPlatform().getExceptionConverter().convertException(
      Object.assign(new Error('new row violates check constraint "wallets_balance_check"'), {
        code: "23514",
        constraint: "wallets_balance_check",
        detail: "Failing row contains (0192f291-27dd, -80.00, BRL, 2).",
      }),
    );
    expect(failure.message).toContain("Failing row");

    expect(await rejectionOf(inSpan("work", {}, () => Promise.reject(failure)))).toBe(failure);

    const span = onlySpan(exporter);
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "23514" });
    expect(span.attributes["error.type"]).toBe("23514");
    expect(span.events.map((event) => event.name)).toEqual(["exception"]);
    const recorded = JSON.stringify(span.events);
    expect(recorded).toContain("wallets_balance_check");
    expect(recorded).not.toContain("Failing row");
    expect(recorded).not.toContain("-80.00");
  });

  test("a refused request is an outcome: its code is recorded, the span is no error", async () => {
    const exporter = traceInMemory();
    const refusal = new IdempotencyConflictError("0192f291-27dd-7000-8000-000000000000");

    expect(await rejectionOf(inSpan("work", {}, () => Promise.reject(refusal)))).toBe(refusal);

    const span = onlySpan(exporter);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes["error.type"]).toBe("IDEMPOTENCY_CONFLICT");
    expect(span.events).toEqual([]);
  });

  test("a transient failure is a failure on this side", async () => {
    const exporter = traceInMemory();
    const busy = new WalletBusyError();

    expect(await rejectionOf(inSpan("work", {}, () => Promise.reject(busy)))).toBe(busy);

    const span = onlySpan(exporter);
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "WALLET_BUSY" });
    expect(span.attributes["error.type"]).toBe("WALLET_BUSY");
  });
});
