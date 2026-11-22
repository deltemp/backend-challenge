import { describe, expect, test } from "bun:test";
import { PostgreSqlPlatform } from "@mikro-orm/postgresql";
import {
  DependencyUnavailableError,
  DuplicateKeyError,
  WalletBusyError,
  WalletNotFoundError,
} from "../../src/application/errors";
import { InvariantViolationError } from "../../src/domain/shared/errors";
import { translateDatabaseError } from "../../src/infrastructure/mikro-orm/database-errors";

/** A PostgreSQL error as MikroORM's converter wraps it. */
function driverError(code: string, fields: Record<string, string> = {}): Error {
  const error = Object.assign(new Error(`server error ${code}`), { code, ...fields });
  return new PostgreSqlPlatform().getExceptionConverter().convertException(error);
}

describe("translateDatabaseError", () => {
  test.each([
    ["wallets_player_id_currency_unique", "wallet-owner"],
    ["wager_transactions_idempotency_key_unique", "idempotency-key"],
    ["wager_transactions_provider_external_id_unique", "external-transaction"],
    ["inbox_messages_pkey", "inbox-message"],
    ["wager_transactions_reversal_unique", "reversal"],
    ["ledger_entries_wallet_version_unique", "other"],
  ])("names the unique key %s as %s", (constraint, key) => {
    const translated = translateDatabaseError(driverError("23505", { constraint }));

    expect(translated).toBeInstanceOf(DuplicateKeyError);
    expect(translated).toMatchObject({ key });
  });

  test.each(["55P03", "40P01", "40001"])("turns contention (%s) into a busy wallet", (code) => {
    expect(translateDatabaseError(driverError(code))).toBeInstanceOf(WalletBusyError);
  });

  test.each([
    "57014",
    "57P01",
    "57P03",
    "25P03",
    "08006",
    "08001",
    "53100",
    "53200",
    "53300",
    "53400",
    "58000",
    "58030",
  ])("turns %s into an unavailable dependency", (code) => {
    expect(translateDatabaseError(driverError(code))).toBeInstanceOf(DependencyUnavailableError);
  });

  test.each([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:55432"), { code: "ECONNREFUSED" }),
    new Error("Connection terminated unexpectedly"),
    new Error("timeout exceeded when trying to connect"),
  ])("turns a lost connection into an unavailable dependency: %p", (error) => {
    expect(translateDatabaseError(error)).toBeInstanceOf(DependencyUnavailableError);
  });

  test("keeps the original error as the cause", () => {
    const original = driverError("55P03");

    expect(translateDatabaseError(original)).toMatchObject({ cause: original });
  });

  test("leaves schema guards, bugs and use case errors as they are", () => {
    const guard = driverError("23514", { constraint: "wallets_ledger_head" });
    const bug = new InvariantViolationError("a bug");
    const notFound = new WalletNotFoundError("w-1");

    expect(translateDatabaseError(guard)).toBe(guard);
    expect(translateDatabaseError(bug)).toBe(bug);
    expect(translateDatabaseError(notFound)).toBe(notFound);
    expect(translateDatabaseError("not an error")).toBe("not an error");
  });
});
