import { describe, expect, test } from "bun:test";
import {
  DependencyUnavailableError,
  DuplicateKeyError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidRequestError,
  WalletBusyError,
  WalletNotFoundError,
} from "../../../src/application/errors";
import { InvalidMoneyError, InvalidWagerTransactionError } from "../../../src/domain/shared/errors";
import { parseMessage, permanentReason } from "../../../src/interfaces/sqs-consumer/messages";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

function message(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return JSON.stringify({
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      idempotencyKey: "provider-a:transaction-123",
      playerId: "player-1",
      walletId: WALLET_ID,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...data,
    },
    ...overrides,
  });
}

describe("parseMessage", () => {
  test("reads the §10 message; a null reference is no reference", () => {
    const parsed = parseMessage(message({}, { referenceExternalTransactionId: null }));

    expect(parsed).toMatchObject({
      ok: true,
      message: { messageId: "msg-123", data: { walletId: WALLET_ID, kind: "BET" } },
    });
    expect(parsed.ok && parsed.message.data.referenceExternalTransactionId).toBeUndefined();
  });

  test("ignores envelope fields it does not know, but not transaction fields", () => {
    expect(parseMessage(message({ traceparent: "00-abc" })).ok).toBe(true);
    expect(parseMessage(message({}, { bonus: true }))).toMatchObject({
      ok: false,
      reason: "VALIDATION_FAILED",
    });
  });

  test("a body that is not a JSON object is malformed", () => {
    for (const body of [undefined, "", "{not json", "[1, 2]", '"text"', "null"]) {
      expect(parseMessage(body)).toMatchObject({ ok: false, reason: "MALFORMED_MESSAGE" });
    }
  });

  test("another message type is unknown, before anything else is checked", () => {
    expect(parseMessage(JSON.stringify({ type: "WagerCancelled" }))).toMatchObject({
      ok: false,
      reason: "UNKNOWN_MESSAGE_TYPE",
    });
  });

  test("an invalid message reports each broken field with its path", () => {
    const parsed = parseMessage(
      message(
        { occurredAt: "yesterday" },
        { kind: "OPENING", money: { amount: 25, currency: "BRL" }, idempotencyKey: "" },
      ),
    );

    expect(parsed.ok).toBe(false);
    const paths = parsed.ok ? [] : parsed.errors.map((issue) => issue.path);
    expect(paths.sort()).toEqual([
      "data.idempotencyKey",
      "data.kind",
      "data.money.amount",
      "occurredAt",
    ]);
  });

  test("a message id the inbox could not store is refused", () => {
    expect(parseMessage(message({ messageId: "m".repeat(129) }))).toMatchObject({
      ok: false,
      reason: "VALIDATION_FAILED",
      errors: [{ path: "messageId" }],
    });
  });
});

describe("permanentReason", () => {
  test.each([
    [new InvalidRequestError([]), "VALIDATION_FAILED"],
    [new InvalidMoneyError("invalid amount"), "VALIDATION_FAILED"],
    [new InvalidWagerTransactionError("a BET cannot reference"), "VALIDATION_FAILED"],
    [new WalletNotFoundError(WALLET_ID), "WALLET_NOT_FOUND"],
    [new InboxConflictError("msg-1"), "INBOX_CONFLICT"],
    [new IdempotencyConflictError("t"), "IDEMPOTENCY_CONFLICT"],
    [new ExternalTransactionConflictError("t"), "EXTERNAL_TRANSACTION_CONFLICT"],
  ] as const)("%p is permanent: %p", (error, reason) => {
    expect(permanentReason(error)).toBe(reason);
  });

  test("transient errors and bugs are not permanent: they are retried", () => {
    for (const error of [
      new WalletBusyError(),
      new DependencyUnavailableError(),
      new DuplicateKeyError("other"),
      new Error("boom"),
    ]) {
      expect(permanentReason(error)).toBeUndefined();
    }
  });
});
