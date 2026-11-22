import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { TransientError } from "../../application/errors";
import { LOGGER } from "../../infrastructure/observability/logger";
import { Metrics } from "../../infrastructure/observability/metrics";
import { problemFor, writeProblem } from "./problem-details";

/**
 * Turns every error that escapes a route into an RFC 9457 problem, the same on every endpoint.
 * Business rejections never get here: they are results, answered with 422 by the controller.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    if (response.headersSent) {
      return;
    }
    // A failed readiness check keeps the health check's body, which names the failing dependency.
    if (exception instanceof HttpException && request.path.startsWith("/health/")) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const problem = problemFor(exception);
    if (problem.code === "UNEXPECTED_ERROR") {
      this.metrics.unexpectedErrors.inc({ component: "http" });
      this.logger.error({ err: exception }, "unexpected error while handling an HTTP request");
    } else if (exception instanceof TransientError) {
      this.logger.warn({ code: problem.code }, "transient failure: the client may resend");
    }
    writeProblem(request, response, problem);
  }
}
