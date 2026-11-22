import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { LOGGER } from "./logger";
import { Metrics } from "./metrics";
import { CORRELATION_ID_HEADER, requestContext, resolveCorrelationId } from "./request-context";

// Probes and scrapes are too frequent to log; they are still measured.
const UNLOGGED_PATH_PREFIXES = ["/health/", "/metrics"];

/**
 * Opens the request context (correlation id) and records duration and an access log line for
 * every HTTP request.
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

    response.once("finish", () => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      // The matched route pattern, never the raw path, keeps the label set bounded.
      const route = request.route?.path ? `${request.baseUrl}${request.route.path}` : "unmatched";
      const statusCode = response.statusCode;

      this.metrics.httpRequestDuration.observe(
        { method: request.method, route, status_code: String(statusCode) },
        durationSeconds,
      );
      if (!UNLOGGED_PATH_PREFIXES.some((prefix) => request.path.startsWith(prefix))) {
        this.logger.info(
          {
            correlationId,
            method: request.method,
            route,
            statusCode,
            durationMs: Math.round(durationSeconds * 1000),
          },
          "http request completed",
        );
      }
    });

    requestContext.run({ correlationId }, next);
  }
}
