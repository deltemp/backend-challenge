import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/domain/money/money";
import {
  canonicalPayload,
  payloadHash,
  type WagerPayload,
} from "../../../src/domain/wagering/payload-hash";
import { WagerTransactionKind } from "../../../src/domain/wagering/wager-transaction";
import { brl, submit } from "./fixtures";

const BET: WagerPayload = {
  providerId: "provider-a",
  externalTransactionId: "txn-1001",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: brl("25.00"),
};

const REFUND: WagerPayload = {
  ...BET,
  externalTransactionId: "txn-1002",
  kind: "REFUND",
  referenceExternalTransactionId: "txn-1001",
};

describe("canonical payload (RFC 8785)", () => {
  test("sorts the keys, keeps no whitespace and writes money with two decimal places", () => {
    expect(canonicalPayload(BET)).toBe(
      '{"externalTransactionId":"txn-1001","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"wallet-1"}',
    );
  });

  test("includes the reference only when there is one, in its sorted place", () => {
    expect(canonicalPayload(REFUND)).toBe(
      '{"externalTransactionId":"txn-1002","gameId":"fortune-chimp","kind":"REFUND",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
        '"providerId":"provider-a","referenceExternalTransactionId":"txn-1001",' +
        '"roundId":"round-987","walletId":"wallet-1"}',
    );
    expect(canonicalPayload({ ...BET, referenceExternalTransactionId: undefined })).toBe(
      canonicalPayload(BET),
    );
  });

  test("escapes strings like JSON, keeping non-ASCII characters as they are", () => {
    const canonical = canonicalPayload({ ...BET, gameId: 'Ação "€" \\ 😀\n' });

    expect(canonical).toContain('"gameId":"Ação \\"€\\" \\\\ 😀\\n"');
  });

  test("does not depend on the order in which the fields were written", () => {
    const reordered: WagerPayload = {
      money: brl("25.00"),
      walletId: "wallet-1",
      kind: "BET",
      gameId: "fortune-chimp",
      roundId: "round-987",
      playerId: "player-1",
      externalTransactionId: "txn-1001",
      providerId: "provider-a",
    };

    expect(canonicalPayload(reordered)).toBe(canonicalPayload(BET));
  });
});

describe("payload hash", () => {
  test("is the SHA-256, in hex, of the canonical payload", () => {
    // Known answers, computed independently with sha256sum over the canonical strings above.
    expect(payloadHash(BET)).toBe(
      "7b324b4cd98988e4178046a8ef32f3e9368a98e0f0c994040d32847c399bb13d",
    );
    expect(payloadHash(REFUND)).toBe(
      "bfeb7325d870470a1a588879f6d49af33b15b7c62d2e7d67576057d2883342e3",
    );
  });

  test('treats "25" and "25.00" as the same amount', () => {
    const unnormalized = { ...BET, money: Money.from({ amount: "25", currency: "BRL" }) };

    expect(payloadHash(unnormalized)).toBe(payloadHash(BET));
  });

  const changes: ReadonlyArray<readonly [string, Partial<WagerPayload>]> = [
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "txn-9999" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: "WIN" }],
    ["amount", { money: brl("25.01") }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
    ["reference", { referenceExternalTransactionId: "txn-1000" }],
  ];
  test.each(changes)("changes with the %s", (_field, change) => {
    expect(payloadHash({ ...BET, ...change })).not.toBe(payloadHash(BET));
  });
});

// §13 unit: idempotency key with a divergent payload.
describe("idempotency comparison", () => {
  test("the idempotency key is not part of the payload: same fields, same hash", () => {
    const first = submit({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: "txn-1",
      idempotencyKey: "key-a",
    });
    const second = submit({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: "txn-1",
      idempotencyKey: "key-b",
    });

    expect(second.payloadHash).toBe(first.payloadHash ?? "");
    expect(first.matchesPayload(second.payloadHash ?? "")).toBe(true);
  });

  test("the same key with a divergent payload does not match: a conflict, never a replay", () => {
    const stored = submit({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: "txn-1",
      idempotencyKey: "key-a",
      money: brl("25.00"),
    });
    const resent = submit({
      kind: WagerTransactionKind.Bet,
      externalTransactionId: "txn-1",
      idempotencyKey: "key-a",
      money: brl("30.00"),
    });

    expect(stored.idempotencyKey).toBe(resent.idempotencyKey ?? "");
    expect(stored.matchesPayload(resent.payloadHash ?? "")).toBe(false);
  });
});
