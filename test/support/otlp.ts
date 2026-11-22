import { eventually } from "./eventually";

// A minimal OTLP/HTTP receiver: the instances under test export their spans to it as they would
// to the collector, and tests read what arrived. OTLP JSON encodes ids as hex and the span kind
// and status as numbers.

export type AttributeValue = string | number | boolean;

export type SpanKindName = "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";

const SPAN_KINDS: Readonly<Record<number, SpanKindName>> = {
  1: "INTERNAL",
  2: "SERVER",
  3: "CLIENT",
  4: "PRODUCER",
  5: "CONSUMER",
};

export interface ExportedSpan {
  readonly traceId: string;
  readonly spanId: string;
  /** Undefined for the root span of a trace. */
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: SpanKindName | undefined;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly links: readonly { readonly traceId: string; readonly spanId: string }[];
  /** 0 unset, 1 ok, 2 error. */
  readonly statusCode: number;
  /** Span events, such as a recorded `exception` with its message and stack trace. */
  readonly events: readonly {
    readonly name: string;
    readonly attributes: Readonly<Record<string, AttributeValue>>;
  }[];
  /** The attributes of the process that exported the span (`service.name`, ...). */
  readonly resource: Readonly<Record<string, AttributeValue>>;
}

interface OtlpValue {
  readonly stringValue?: string;
  readonly intValue?: number | string;
  readonly doubleValue?: number;
  readonly boolValue?: boolean;
}

interface OtlpKeyValue {
  readonly key: string;
  readonly value?: OtlpValue;
}

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind?: number;
  readonly attributes?: readonly OtlpKeyValue[];
  readonly links?: readonly { readonly traceId: string; readonly spanId: string }[];
  readonly status?: { readonly code?: number };
  readonly events?: readonly { readonly name: string; readonly attributes?: OtlpKeyValue[] }[];
}

interface OtlpExport {
  readonly resourceSpans?: readonly {
    readonly resource?: { readonly attributes?: readonly OtlpKeyValue[] };
    readonly scopeSpans?: readonly { readonly spans?: readonly OtlpSpan[] }[];
  }[];
}

function attributesOf(list: readonly OtlpKeyValue[] = []): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {};
  for (const { key, value } of list) {
    const scalar =
      value?.stringValue ??
      value?.boolValue ??
      value?.doubleValue ??
      (value?.intValue === undefined ? undefined : Number(value.intValue));
    if (scalar !== undefined) {
      attributes[key] = scalar;
    }
  }
  return attributes;
}

function spansOf(request: OtlpExport): ExportedSpan[] {
  return (request.resourceSpans ?? []).flatMap((resourceSpans) => {
    const resource = attributesOf(resourceSpans.resource?.attributes);
    return (resourceSpans.scopeSpans ?? []).flatMap((scope) =>
      (scope.spans ?? []).map(
        (span): ExportedSpan => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId === "" ? undefined : span.parentSpanId,
          name: span.name,
          kind: span.kind === undefined ? undefined : SPAN_KINDS[span.kind],
          attributes: attributesOf(span.attributes),
          links: (span.links ?? []).map((link) => ({
            traceId: link.traceId,
            spanId: link.spanId,
          })),
          statusCode: span.status?.code ?? 0,
          events: (span.events ?? []).map((event) => ({
            name: event.name,
            attributes: attributesOf(event.attributes),
          })),
          resource,
        }),
      ),
    );
  });
}

export interface OtlpReceiver {
  /** The base URL to give as `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint: string;
  /** Every span received so far. */
  spans(): readonly ExportedSpan[];
  /** Waits for a span that matches, and returns it. */
  waitForSpan(description: string, matches: (span: ExportedSpan) => boolean): Promise<ExportedSpan>;
  stop(): Promise<void>;
}

export function startOtlpReceiver(): OtlpReceiver {
  const received: ExportedSpan[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/traces") {
        return new Response("not found", { status: 404 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const text = new TextDecoder().decode(
        request.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes,
      );
      received.push(...spansOf(JSON.parse(text) as OtlpExport));
      return Response.json({});
    },
  });
  const spans = () => [...received];
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    spans,
    waitForSpan: (description, matches) =>
      eventually(`span: ${description}`, async () => spans().find(matches)),
    stop: () => server.stop(true),
  };
}

/** A W3C trace context as a caller would send it: a new trace, sampled. */
export function callerTraceContext(): {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceparent: string;
} {
  const hex = (bytes: number) =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
  const traceId = hex(16);
  const spanId = hex(8);
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

/** The trace and span ids of a `traceparent` header. */
export function parseTraceparent(
  traceparent: string | undefined,
): { readonly traceId: string; readonly spanId: string } | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent ?? "");
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { traceId: match[1], spanId: match[2] };
}
