import { HttpException } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import {
  DependencyUnavailableError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidCursorError,
  InvalidRequestError,
  TransactionNotFoundError,
  type ValidationIssue,
  WalletAlreadyExistsError,
  WalletBusyError,
  WalletNotFoundError,
} from "../../application/errors";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../domain/shared/errors";
import { CORRELATION_ID_HEADER } from "../../infrastructure/observability/request-context";

/** The `Idempotency-Key` header is missing or blank (`IDEMPOTENCY_KEY_REQUIRED`). */
export class IdempotencyKeyRequiredError extends Error {
  override readonly name = "IdempotencyKeyRequiredError";
}

/** One protocol error, before it becomes an RFC 9457 body. */
export interface Problem {
  readonly status: number;
  /** Stable and machine-readable, like failure codes: a public contract. */
  readonly code: string;
  readonly detail: string;
  readonly errors?: readonly ValidationIssue[];
  readonly retryAfterSeconds?: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

// With `type: about:blank`, RFC 9457 makes the title the status phrase.
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  413: "Content Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

// A busy wallet frees up within a lock timeout; an outage takes longer.
const WALLET_BUSY_RETRY_AFTER_SECONDS = 1;
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

export const MALFORMED_JSON: Problem = {
  status: 400,
  code: "MALFORMED_JSON",
  detail: "The request body is not valid JSON.",
};

export const PAYLOAD_TOO_LARGE: Problem = {
  status: 413,
  code: "PAYLOAD_TOO_LARGE",
  detail: "The request body is larger than the accepted limit.",
};

export const UNEXPECTED_ERROR: Problem = {
  status: 500,
  code: "UNEXPECTED_ERROR",
  detail: "An unexpected error occurred. It was logged under this correlation id.",
};

function invalid(errors: readonly ValidationIssue[]): Problem {
  return {
    status: 400,
    code: "VALIDATION_FAILED",
    detail: "The request breaks the API contract: see errors.",
    errors,
  };
}

/**
 * The problem for an error. Details come from this table, never from error messages, which may
 * carry ids of other transactions. A domain contract error has no single field, so its path is
 * empty: the request as a whole.
 */
export function problemFor(error: unknown): Problem {
  if (error instanceof InvalidRequestError) {
    return invalid(error.errors);
  }
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return invalid([{ path: "", message: error.message }]);
  }
  if (error instanceof IdempotencyKeyRequiredError) {
    return {
      status: 400,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      detail: "The Idempotency-Key header is required.",
    };
  }
  if (error instanceof InvalidCursorError) {
    return {
      status: 400,
      code: "INVALID_CURSOR",
      detail: "The ledger cursor was not issued by this service.",
    };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 404, code: "WALLET_NOT_FOUND", detail: "The wallet does not exist." };
  }
  if (error instanceof TransactionNotFoundError) {
    return {
      status: 404,
      code: "TRANSACTION_NOT_FOUND",
      detail: "The transaction does not exist.",
    };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      detail: "The idempotency key was already used with a different payload.",
    };
  }
  if (error instanceof ExternalTransactionConflictError) {
    return {
      status: 409,
      code: "EXTERNAL_TRANSACTION_CONFLICT",
      detail: "The provider's transaction id was already used under another idempotency key.",
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return {
      status: 409,
      code: "WALLET_ALREADY_EXISTS",
      detail: "A wallet already exists for this player and currency.",
      extensions: error.walletId === undefined ? undefined : { walletId: error.walletId },
    };
  }
  if (error instanceof WalletBusyError) {
    return {
      status: 503,
      code: "WALLET_BUSY",
      detail: "The wallet is busy. Resend the request later with the same idempotency key.",
      retryAfterSeconds: WALLET_BUSY_RETRY_AFTER_SECONDS,
    };
  }
  if (error instanceof DependencyUnavailableError) {
    return {
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
      detail:
        "A dependency is unavailable. Resend the request later with the same idempotency key.",
      retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
    };
  }
  if (error instanceof HttpException) {
    return problemForHttpException(error.getStatus());
  }
  return UNEXPECTED_ERROR;
}

// The only HTTP exceptions left are the framework's own: an unmatched route above all.
function problemForHttpException(status: number): Problem {
  if (status === 404) {
    return { status, code: "ROUTE_NOT_FOUND", detail: "No route matches this method and path." };
  }
  if (status === 413) {
    return PAYLOAD_TOO_LARGE;
  }
  if (status >= 400 && status < 500) {
    return invalid([]);
  }
  return UNEXPECTED_ERROR;
}

/** Writes the RFC 9457 body, identical in shape on every endpoint. */
export function writeProblem(request: Request, response: Response, problem: Problem): void {
  if (problem.retryAfterSeconds !== undefined) {
    response.setHeader("Retry-After", String(problem.retryAfterSeconds));
  }
  response
    .status(problem.status)
    .type("application/problem+json")
    .json({
      type: "about:blank",
      title: TITLES[problem.status] ?? "Error",
      status: problem.status,
      detail: problem.detail,
      instance: request.path,
      code: problem.code,
      correlationId: response.getHeader(CORRELATION_ID_HEADER),
      ...problem.extensions,
      ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    });
}

function isBodyParserError(error: unknown): error is { readonly type: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string" &&
    "status" in error
  );
}

/**
 * Express error handler registered right after the JSON parser, before any route: a body that is
 * too large or not JSON is answered with the same problem shape as everything else.
 */
export function bodyParserErrorHandler(logger: Logger) {
  return (error: unknown, request: Request, response: Response, _next: NextFunction): void => {
    if (isBodyParserError(error)) {
      writeProblem(
        request,
        response,
        error.type === "entity.too.large" ? PAYLOAD_TOO_LARGE : MALFORMED_JSON,
      );
      return;
    }
    logger.error({ err: error }, "unexpected error before routing");
    writeProblem(request, response, UNEXPECTED_ERROR);
  };
}
