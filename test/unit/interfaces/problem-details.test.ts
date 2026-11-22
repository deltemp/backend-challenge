import { describe, expect, test } from "bun:test";
import { NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import {
  DependencyUnavailableError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidCursorError,
  InvalidRequestError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletBusyError,
  WalletNotFoundError,
} from "../../../src/application/errors";
import {
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvariantViolationError,
} from "../../../src/domain/shared/errors";
import { WagerTransactionStatus } from "../../../src/domain/wagering/wager-transaction";
import {
  IdempotencyKeyRequiredError,
  problemFor,
} from "../../../src/interfaces/http/problem-details";
import { submissionStatus } from "../../../src/interfaces/http/wagering/wager-transactions.controller";

describe("problemFor", () => {
  test.each([
    [
      new InvalidRequestError([{ path: "walletId", message: "must be a lowercase UUID" }]),
      400,
      "VALIDATION_FAILED",
    ],
    [new IdempotencyKeyRequiredError(), 400, "IDEMPOTENCY_KEY_REQUIRED"],
    [new InvalidCursorError(), 400, "INVALID_CURSOR"],
    [new WalletNotFoundError("w"), 404, "WALLET_NOT_FOUND"],
    [new TransactionNotFoundError(), 404, "TRANSACTION_NOT_FOUND"],
    [new NotFoundException(), 404, "ROUTE_NOT_FOUND"],
    [new IdempotencyConflictError("t"), 409, "IDEMPOTENCY_CONFLICT"],
    [new ExternalTransactionConflictError("t"), 409, "EXTERNAL_TRANSACTION_CONFLICT"],
    [new WalletAlreadyExistsError("w"), 409, "WALLET_ALREADY_EXISTS"],
    [new PayloadTooLargeException(), 413, "PAYLOAD_TOO_LARGE"],
    [new WalletBusyError(), 503, "WALLET_BUSY"],
    [new DependencyUnavailableError(), 503, "DEPENDENCY_UNAVAILABLE"],
    [new InvariantViolationError("negative balance"), 500, "UNEXPECTED_ERROR"],
    [new Error("boom"), 500, "UNEXPECTED_ERROR"],
  ] as const)("%p is %p %p", (error, status, code) => {
    expect(problemFor(error)).toMatchObject({ status, code });
  });

  test("a validation error lists its issues; a domain contract error has the whole request as its path", () => {
    expect(
      problemFor(new InvalidRequestError([{ path: "roundId", message: "too long" }])),
    ).toMatchObject({
      errors: [{ path: "roundId", message: "too long" }],
    });
    expect(problemFor(new InvalidWagerTransactionError("REFUND needs a reference"))).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ path: "", message: "REFUND needs a reference" }],
    });
    expect(problemFor(new InvalidMoneyError("invalid amount"))).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ path: "", message: "invalid amount" }],
    });
  });

  test("every 503 tells the client when to resend", () => {
    expect(problemFor(new WalletBusyError()).retryAfterSeconds).toBe(1);
    expect(problemFor(new DependencyUnavailableError()).retryAfterSeconds).toBe(5);
  });

  test("details come from the contract, never from error messages that name other transactions", () => {
    const problem = problemFor(
      new IdempotencyConflictError("0192f298-345e-7e38-af88-e43f851a819d"),
    );

    expect(problem.detail).not.toContain("0192f298");
    expect(problem.extensions).toBeUndefined();
  });

  test("a duplicate wallet names the wallet that exists", () => {
    expect(problemFor(new WalletAlreadyExistsError("wallet-1")).extensions).toEqual({
      walletId: "wallet-1",
    });
  });
});

describe("submissionStatus", () => {
  test("PROCESSED is 200, PENDING_REFERENCE 202, and both final outcomes that are no success 422", () => {
    expect(submissionStatus(WagerTransactionStatus.Processed)).toBe(200);
    expect(submissionStatus(WagerTransactionStatus.PendingReference)).toBe(202);
    expect(submissionStatus(WagerTransactionStatus.Rejected)).toBe(422);
    expect(submissionStatus(WagerTransactionStatus.Failed)).toBe(422);
  });

  test("PENDING is never stored, so never answered", () => {
    expect(() => submissionStatus(WagerTransactionStatus.Pending)).toThrow(InvariantViolationError);
  });
});
