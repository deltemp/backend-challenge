import { createHash } from "node:crypto";
import type { Money } from "../money/money";

/** The business fields of a submitted transaction: what idempotency compares. */
export interface WagerPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
}

/**
 * RFC 8785 (JCS) canonical JSON of the business fields. The idempotency key, headers and
 * transport metadata are not part of it. Money is normalized to two decimal places, so `"25"`
 * and `"25.00"` are the same payload. Every value is a string or an object of strings, so
 * canonicalization reduces to keys sorted by UTF-16 code unit and JSON string escaping.
 */
export function canonicalPayload(payload: WagerPayload): string {
  const fields: Record<string, string | Record<string, string>> = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
  };
  if (payload.referenceExternalTransactionId !== undefined) {
    fields.referenceExternalTransactionId = payload.referenceExternalTransactionId;
  }
  return canonicalize(fields);
}

/** SHA-256, in hex, of the canonical payload. */
export function payloadHash(payload: WagerPayload): string {
  return createHash("sha256").update(canonicalPayload(payload), "utf8").digest("hex");
}

function canonicalize(value: string | Record<string, string | Record<string, string>>): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  const members = Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => {
      const member = value[key];
      if (member === undefined) {
        throw new TypeError(`missing value for ${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(member)}`;
    });
  return `{${members.join(",")}}`;
}
