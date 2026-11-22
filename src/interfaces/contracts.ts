import { z } from "zod";
import type { ValidationIssue } from "../application/errors";
import { type IdentifierPath, identifierIssue, isUuid } from "../application/request-limits";
import { LEDGER_PAGE_MAX } from "../application/use-cases/queries";
import { Money, validateCurrency } from "../domain/money/money";
import { InvalidMoneyError } from "../domain/shared/errors";
import { WagerTransactionKind } from "../domain/wagering/wager-transaction";

// The request contracts of the HTTP API and of the queue. Every rule comes from the layer that
// owns it (identifier limits from the use cases, amounts and currencies from Money), so the
// interfaces report a broken field with its path instead of keeping a second copy of the rules.

/** An identifier with the limits the schema and the use cases enforce. */
export function identifier(path: IdentifierPath) {
  return z.string().superRefine((value, context) => {
    const issue = identifierIssue(path, value);
    if (issue !== undefined) {
      context.addIssue({ code: "custom", message: issue });
    }
  });
}

function moneyRule(check: (value: string) => void) {
  return z.string().superRefine((value, context) => {
    try {
      check(value);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) {
        throw error;
      }
      context.addIssue({ code: "custom", message: error.message });
    }
  });
}

/** `{ amount, currency }` as decimal strings, never numbers. XXX is ISO-4217's "no currency". */
export const money = z.strictObject({
  amount: moneyRule((amount) => Money.from({ amount, currency: "XXX" })),
  currency: moneyRule((currency) => validateCurrency(currency)),
});

const lowercaseUuid = z.string().refine(isUuid, "must be a lowercase UUID");

/** OPENING is internal: it can be submitted neither through the API nor through the queue. */
const submittableKind = z.enum([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const wagerTransactionFields = {
  providerId: identifier("providerId"),
  externalTransactionId: identifier("externalTransactionId"),
  playerId: identifier("playerId"),
  walletId: lowercaseUuid,
  roundId: identifier("roundId"),
  gameId: identifier("gameId"),
  kind: submittableKind,
  money,
  // A null reference means no reference, as an absent one does.
  referenceExternalTransactionId: identifier("referenceExternalTransactionId")
    .nullish()
    .transform((reference) => reference ?? undefined),
};

/** `POST /wagering/transactions`; the idempotency key arrives in its header. */
export const wagerTransactionBody = z.strictObject(wagerTransactionFields);
export type WagerTransactionBody = z.output<typeof wagerTransactionBody>;

/** `POST /wallets`. */
export const openWalletBody = z.strictObject({
  playerId: identifier("playerId"),
  initialBalance: money,
});
export type OpenWalletBody = z.output<typeof openWalletBody>;

/**
 * `GET /wallets/:walletId/ledger`. Unknown query parameters are ignored. Any cursor string goes
 * through: the use case refuses one it did not issue with `INVALID_CURSOR`, whatever its length.
 */
export const ledgerQuery = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/, `must be an integer from 1 to ${LEDGER_PAGE_MAX}`)
    .transform(Number)
    .pipe(z.number().int().min(1).max(LEDGER_PAGE_MAX))
    .optional(),
});
export type LedgerQuery = z.output<typeof ledgerQuery>;

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/**
 * The inbound queue message (§10). The envelope ignores transport fields it does not know; the
 * transaction itself is as strict as the HTTP body and carries its idempotency key.
 */
export const wagerTransactionRequested = z.object({
  messageId: identifier("messageId"),
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({ ...wagerTransactionFields, idempotencyKey: identifier("idempotencyKey") }),
});
export type WagerTransactionRequested = z.output<typeof wagerTransactionRequested>;

type PathSegment = PropertyKey | { readonly key: PropertyKey };

/** A validation issue as the contract reports it: a dotted path, empty for the whole request. */
export function validationIssue(issue: {
  readonly path?: readonly PathSegment[] | undefined;
  readonly message: string;
}): ValidationIssue {
  const path = (issue.path ?? []).map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
  return { path: path.join("."), message: issue.message };
}
