import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from "@opentelemetry/semantic-conventions";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { LOGGER } from "./logger";
import { Metrics } from "./metrics";
import { CORRELATION_ID_HEADER, requestContext, resolveCorrelationId } from "./request-context";
import { tracer } from "./tracing";

// Probes and scrapes are too frequent to log or trace; they are still measured.
const UNLOGGED_PATH_PREFIXES = ["/health/", "/metrics"];

/**
 * Opens the request context (correlation id) and the server span, and records duration and an
 * access log line for every HTTP request. The span continues the caller's `traceparent`.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = resolveCorrelationId(request.header(CORRELATION_ID_HEADER));
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    const startedAt = process.hrtime.bigint();
    const quiet = UNLOGGED_PATH_PREFIXES.some((prefix) => request.path.startsWith(prefix));
    const parent = propagation.extract(ROOT_CONTEXT, request.headers);
    const span = quiet
      ? undefined
      : tracer().startSpan(
          request.method,
          {
            kind: SpanKind.SERVER,
            attributes: {
              [ATTR_HTTP_REQUEST_METHOD]: request.method,
              [ATTR_URL_PATH]: request.path,
              "app.correlation_id": correlationId,
            },
          },
          parent,
        );

    response.once("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      // The matched route pattern, never the raw path, keeps the label set bounded.
      const route = request.route?.path ? `${request.baseUrl}${request.route.path}` : "unmatched";
      const statusCode = response.statusCode;

      this.metrics.httpRequestDuration.observe(
        { method: request.method, route, status_code: String(statusCode) },
        durationSeconds,
      );
      if (span !== undefined) {
        span.updateName(route === "unmatched" ? request.method : `${request.method} ${route}`);
        span.setAttribute(ATTR_HTTP_ROUTE, route);
        span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, statusCode);
        if (statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      }
      if (!quiet) {
        this.logger.info(
          {
            correlationId,
            traceId: span?.isRecording() ? span.spanContext().traceId : undefined,
            method: request.method,
            route,
            statusCode,
            durationMs: Math.round(durationSeconds * 1000),
          },
          "http request completed",
        );
      }
      span?.end();
    });
    // A request the client abandons never finishes: its span still ends, once.
    response.once("close", () => {
      if (!response.writableFinished) {
        span?.end();
      }
    });

    const handle = () => requestContext.run({ correlationId }, next);
    if (span === undefined) {
      handle();
    } else {
      context.with(trace.setSpan(parent, span), handle);
    }
  }
}
