import { trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Logger } from "pino";
import type { LogLevel } from "../config/config";
import { requestContext } from "./request-context";

/** Injection token for the application's pino logger. */
export const LOGGER = Symbol("LOGGER");

// Logs must not carry financial payloads in the first place. Redaction is the safety net for
// a payload that slips through, one or two levels deep.
const FINANCIAL_KEYS = [
  "money",
  "amount",
  "balance",
  "initialBalance",
  "balanceBefore",
  "balanceAfter",
  "storedBalance",
  "calculatedBalance",
  "difference",
];
const SECRET_KEYS = ["authorization", "cookie", "password", "secret", "token"];

const REDACTED_PATHS = [...FINANCIAL_KEYS, ...SECRET_KEYS].flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

// Database errors carry row values in fields such as `detail` ("Failing row contains (...)"),
// `where` or the failed query. Errors are therefore logged through an allowlist, never with all
// their properties.
const SAFE_ERROR_FIELDS = ["code", "constraint", "table", "column"] as const;
const MAX_CAUSE_DEPTH = 3;

/**
 * MikroORM's PostgreSQL error converter appends the error's `detail` and `hint` to its message
 * ("\n - detail: Failing row contains (...)"), and the stack repeats the message. Both are
 * removed again here, so the row values they carry never reach the logs.
 */
function withoutDriverDetails(text: string | undefined, error: Error): string | undefined {
  let result = text;
  for (const field of ["detail", "hint"] as const) {
    const value: unknown = Reflect.get(error, field);
    if (result !== undefined && typeof value === "string" && value.trim() !== "") {
      result = result.replaceAll(`\n - ${field}: ${value}`, "");
    }
  }
  return result;
}

export function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: String(error) };
  }
  const serialized: Record<string, unknown> = {
    type: error.constructor.name,
    message: withoutDriverDetails(error.message, error),
    stack: withoutDriverDetails(error.stack, error),
  };
  for (const field of SAFE_ERROR_FIELDS) {
    const value: unknown = Reflect.get(error, field);
    if (typeof value === "string" || typeof value === "number") {
      serialized[field] = value;
    }
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(error.cause, depth + 1);
  }
  return serialized;
}

/** The ids of the active trace, so a log line leads to its trace; nothing outside a traced span. */
function traceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (span === undefined || !span.isRecording()) {
    return {};
  }
  const { traceId, spanId } = span.spanContext();
  return { traceId, spanId };
}

/**
 * Log errors under `err` (or `error`) so they go through {@link serializeError}. Lines go to
 * stdout unless a destination is given (tests capture them).
 */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ ...requestContext.getStore(), ...traceIds() }),
      redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
      serializers: { err: serializeError, error: serializeError },
    },
    destination,
  );
}
