import { describe, expect, test } from "bun:test";
import { InvalidCursorError } from "../../../src/application/errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "../../../src/application/ledger-cursor";

describe("ledger cursor", () => {
  test("encodes a wallet version in base64url and decodes it back", () => {
    for (const version of [1, 2, 99, 1234567, 2_147_483_647]) {
      const cursor = encodeLedgerCursor(version);

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeLedgerCursor(cursor)).toBe(version);
    }
  });

  test.each([
    ["not base64url", "%%%"],
    ["empty", ""],
    ["a word", Buffer.from("abc").toString("base64url")],
    ["zero", Buffer.from("0").toString("base64url")],
    ["negative", Buffer.from("-5").toString("base64url")],
    ["a leading zero", Buffer.from("07").toString("base64url")],
    ["a fraction", Buffer.from("1.5").toString("base64url")],
    ["beyond a version", Buffer.from("2147483648").toString("base64url")],
    ["padded base64", Buffer.from("12").toString("base64")],
    ["a valid cursor with noise", `${encodeLedgerCursor(12)}!`],
  ])("refuses a cursor that is %s", (_description, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});
