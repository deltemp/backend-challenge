import {
  ApplicationError,
  DependencyUnavailableError,
  type DuplicateKey,
  DuplicateKeyError,
  WalletBusyError,
} from "../../application/errors";

// MikroORM's PostgreSQL converter types only some SQLSTATEs (unique, foreign key, check...);
// lock and statement timeouts arrive as plain driver errors. The mapping therefore reads the
// SQLSTATE itself.

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The unique keys a use case can race on, by constraint name. */
const DUPLICATE_KEYS: Readonly<Record<string, DuplicateKey>> = {
  wallets_player_id_currency_unique: "wallet-owner",
  wager_transactions_idempotency_key_unique: "idempotency-key",
  wager_transactions_provider_external_id_unique: "external-transaction",
  inbox_messages_pkey: "inbox-message",
  wager_transactions_reversal_unique: "reversal",
};

/** lock_not_available (lock_timeout), deadlock_detected, serialization_failure. */
const CONTENTION = new Set(["55P03", "40P01", "40001"]);

/**
 * query_canceled (statement_timeout), admin_shutdown, crash_shutdown, cannot_connect_now,
 * idle_in_transaction_session_timeout. Whole classes are checked apart: 08 (connection
 * exception), 53 (insufficient resources: disk, memory, connections) and 58 (system or I/O
 * error). All of them can pass: a parked transaction that meets one must stay parked, never
 * become FAILED.
 */
const UNAVAILABLE = new Set(["57014", "57P01", "57P02", "57P03", "25P03"]);
const UNAVAILABLE_CLASSES = ["08", "53", "58"];

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** Messages of the pg driver and its pool when a connection is lost or cannot be obtained. */
const CONNECTION_LOST = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection timeout/i,
  /not queryable/i,
];

/**
 * Maps a failed unit of work to what the use cases handle: a race on a unique key, a contended
 * wallet, or an unavailable database. Anything else (a bug, a schema guard, a domain error) is
 * returned unchanged. The original error stays as the `cause`.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (
    !(error instanceof Error) ||
    error instanceof ApplicationError ||
    error instanceof DuplicateKeyError
  ) {
    return error;
  }
  const code = stringField(error, "code");
  if (code !== undefined && SQLSTATE.test(code)) {
    if (code === "23505") {
      const key = DUPLICATE_KEYS[stringField(error, "constraint") ?? ""] ?? "other";
      return new DuplicateKeyError(key, { cause: error });
    }
    if (CONTENTION.has(code)) {
      return new WalletBusyError({ cause: error });
    }
    if (UNAVAILABLE.has(code) || UNAVAILABLE_CLASSES.some((prefix) => code.startsWith(prefix))) {
      return new DependencyUnavailableError({ cause: error });
    }
    return error;
  }
  if (
    (code !== undefined && NETWORK_CODES.has(code)) ||
    CONNECTION_LOST.some((pattern) => pattern.test(error.message))
  ) {
    return new DependencyUnavailableError({ cause: error });
  }
  return error;
}

function stringField(error: Error, field: string): string | undefined {
  const value: unknown = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}
