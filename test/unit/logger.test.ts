import { describe, expect, test } from "bun:test";
import { PostgreSqlPlatform } from "@mikro-orm/postgresql";
import { serializeError } from "../../src/infrastructure/observability/logger";

/** The shape of a PostgreSQL check-constraint violation, as the pg driver reports it. */
function checkViolation(): Error {
  return Object.assign(
    new Error('new row for relation "wallets" violates check constraint "wallets_balance_check"'),
    {
      code: "23514",
      constraint: "wallets_balance_check",
      table: "wallets",
      detail: "Failing row contains (0192f291-27dd, -80.00, BRL, 2).",
      where: "SQL statement in function apply_bet",
      query: "update wallets set balance = $1 where id = $2",
      parameters: ["-80.00", "0192f291-27dd"],
    },
  );
}

describe("serializeError", () => {
  test("keeps what identifies the failure", () => {
    const serialized = serializeError(checkViolation());

    expect(serialized).toMatchObject({
      type: "Error",
      code: "23514",
      constraint: "wallets_balance_check",
      table: "wallets",
    });
    expect(serialized.stack).toBeString();
  });

  test("drops the fields that carry row values or queries", () => {
    const serialized = JSON.stringify(serializeError(checkViolation()));

    expect(serialized).not.toContain("-80.00");
    expect(serialized).not.toContain("Failing row");
    expect(serialized).not.toContain("update wallets");
  });

  test("applies the same allowlist to the cause chain", () => {
    const wrapper = new Error("transaction failed", { cause: checkViolation() });

    const serialized = serializeError(wrapper);

    expect(serialized.cause).toMatchObject({ constraint: "wallets_balance_check" });
    expect(JSON.stringify(serialized)).not.toContain("Failing row");
  });

  test("removes the detail that MikroORM appends to the message and the stack", () => {
    // MikroORM's PostgreSQL converter appends `detail` to the message the logs keep.
    const converted = new PostgreSqlPlatform()
      .getExceptionConverter()
      .convertException(checkViolation());
    expect(converted.message).toContain("Failing row");

    const serialized = serializeError(converted);

    expect(serialized).toMatchObject({ code: "23514", constraint: "wallets_balance_check" });
    expect(String(serialized.message)).toContain("wallets_balance_check");
    expect(JSON.stringify(serialized)).not.toContain("Failing row");
    expect(JSON.stringify(serialized)).not.toContain("-80.00");
  });

  test("describes values thrown that are not errors", () => {
    expect(serializeError("boom")).toEqual({ type: "string", message: "boom" });
  });
});
