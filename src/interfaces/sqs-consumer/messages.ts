import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidRequestError,
  type ValidationIssue,
  WalletNotFoundError,
} from "../../application/errors";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../domain/shared/errors";
import {
  validationIssue,
  WAGER_TRANSACTION_REQUESTED,
  type WagerTransactionRequested,
  wagerTransactionRequested,
} from "../contracts";

/** Why a message went straight to the dead-letter queue: bounded, so a safe metric label. */
export type DeadLetterReason =
  | "MALFORMED_MESSAGE"
  | "UNKNOWN_MESSAGE_TYPE"
  | "VALIDATION_FAILED"
  | "WALLET_NOT_FOUND"
  | "INBOX_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "EXTERNAL_TRANSACTION_CONFLICT";

export type ParsedMessage =
  | { readonly ok: true; readonly message: WagerTransactionRequested }
  | {
      readonly ok: false;
      readonly reason: "MALFORMED_MESSAGE" | "UNKNOWN_MESSAGE_TYPE" | "VALIDATION_FAILED";
      readonly errors: readonly ValidationIssue[];
    };

/** Reads a message body. Nothing in it is trusted before this: the queue is internal, not safe. */
export function parseMessage(body: string | undefined): ParsedMessage {
  let json: unknown;
  try {
    json = JSON.parse(body ?? "");
  } catch {
    return refused("MALFORMED_MESSAGE", "the body is not valid JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return refused("MALFORMED_MESSAGE", "the body is not a JSON object");
  }
  if (!("type" in json) || json.type !== WAGER_TRANSACTION_REQUESTED) {
    return {
      ok: false,
      reason: "UNKNOWN_MESSAGE_TYPE",
      errors: [{ path: "type", message: `must be ${WAGER_TRANSACTION_REQUESTED}` }],
    };
  }
  const result = wagerTransactionRequested.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      reason: "VALIDATION_FAILED",
      errors: result.error.issues.map(validationIssue),
    };
  }
  return { ok: true, message: result.data };
}

function refused(reason: "MALFORMED_MESSAGE", message: string): ParsedMessage {
  return { ok: false, reason, errors: [{ path: "", message }] };
}

/**
 * A permanent error: the message can never succeed as it was sent, so retrying it only delays
 * the dead-letter queue. Conflicts are permanent too: over HTTP they are a 409 to the caller,
 * and from the queue nobody would see them unless they are kept.
 */
export function permanentReason(error: unknown): DeadLetterReason | undefined {
  if (
    error instanceof InvalidRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError
  ) {
    return "VALIDATION_FAILED";
  }
  if (error instanceof WalletNotFoundError) {
    return "WALLET_NOT_FOUND";
  }
  if (error instanceof InboxConflictError) {
    return "INBOX_CONFLICT";
  }
  if (error instanceof IdempotencyConflictError) {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error instanceof ExternalTransactionConflictError) {
    return "EXTERNAL_TRANSACTION_CONFLICT";
  }
  return undefined;
}
