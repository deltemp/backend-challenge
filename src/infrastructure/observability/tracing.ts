import { hostname } from "node:os";
import {
  type Context,
  context,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  ATTR_ERROR_TYPE,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
import { ApplicationError, TransientError } from "../../application/errors";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../domain/shared/errors";
import type { TracingConfig } from "../config/config";
import { serializeError } from "./logger";

// Manual spans only: the NestJS instrumentation does not support NestJS 12, and automatic
// instrumentation is fragile on Bun. Spans carry ids and outcomes, never amounts or payloads.

const TRACER_NAME = "wagering-processor";

/** Messaging attribute names, still incubating in the semantic conventions. */
export const MESSAGING = {
  system: "messaging.system",
  destination: "messaging.destination.name",
  operation: "messaging.operation.type",
  messageId: "messaging.message.id",
  batchSize: "messaging.batch.message_count",
} as const;

/** Flushes and stops the tracer provider; does nothing when tracing is off. */
export interface Tracing {
  shutdown(): Promise<void>;
}

/**
 * Registers the tracer provider, the context manager and the W3C propagator, when an OTLP
 * endpoint is configured. Otherwise nothing is registered and the OpenTelemetry API stays a
 * no-op: spans cost nothing and no trace context is propagated or stored.
 */
export function startTracing(config: TracingConfig): Tracing {
  if (config.endpoint === undefined) {
    return { shutdown: () => Promise.resolve() };
  }
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_INSTANCE_ID]: `${hostname()}/${process.pid}`,
    }),
    // A caller's decision is followed; new traces are sampled at the configured ratio.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `${config.endpoint.replace(/\/+$/, "")}/v1/traces`,
        }),
        scheduledDelayMillis: config.exportDelayMs,
      }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  return { shutdown: () => provider.shutdown() };
}

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Whether a recording span is active: child spans are only worth creating under one. */
export function hasActiveSpan(): boolean {
  return trace.getActiveSpan()?.isRecording() ?? false;
}

/**
 * Runs `work` in a new active span, ended when it settles. A thrown error is recorded on it
 * (`failSpan`) and thrown again.
 */
export function inSpan<T>(
  name: string,
  options: SpanOptions,
  work: (span: Span) => Promise<T>,
  parent: Context = context.active(),
): Promise<T> {
  return tracer().startActiveSpan(name, options, parent, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Records an error on a span with its stable code as `error.type`. Only a failure on this side
 * (a bug, a transient error) makes the span an error; a refused request is an outcome. The
 * exception goes through the log serializer, so database row values never reach a trace.
 */
export function failSpan(span: Span, error: unknown): void {
  const code: unknown = Reflect.get(Object(error), "code");
  const serialized = serializeError(error);
  const type = typeof code === "string" ? code : String(serialized.type);
  span.setAttribute(ATTR_ERROR_TYPE, type);
  if (isCallerError(error)) {
    return;
  }
  span.recordException({
    name: String(serialized.type),
    message: String(serialized.message),
    ...(typeof serialized.stack === "string" ? { stack: serialized.stack } : {}),
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}

function isCallerError(error: unknown): boolean {
  if (error instanceof TransientError) {
    return false;
  }
  return (
    error instanceof ApplicationError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError
  );
}

/** The W3C trace context of the active span, as message headers: empty when nothing is traced. */
export function activeTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  // A caller's tracestate whose entries are all invalid comes back as an empty header. SQS
  // refuses an empty attribute, and a stored context must always be sendable: drop it here.
  return Object.fromEntries(Object.entries(carrier).filter(([, value]) => value !== ""));
}

/** The context that message headers carry, to continue their trace. */
export function contextFrom(carrier: Readonly<Record<string, string | undefined>>): Context {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/** A link to the span that message headers carry; undefined when they carry none. */
export function linkFrom(carrier: Readonly<Record<string, string | undefined>>): Link | undefined {
  const spanContext = trace.getSpanContext(contextFrom(carrier));
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? { context: spanContext }
    : undefined;
}
