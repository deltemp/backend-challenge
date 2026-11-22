import { InvalidRequestError, type ValidationIssue } from "./errors";

// The limits the schema enforces on identifiers (AGENTS.md, "Identifier limits"). Checked
// before any SQL runs, so an oversized or malformed value is a validation error, never a
// database error. JavaScript counts UTF-16 units where PostgreSQL counts characters, so this
// check is never looser than the schema's.

export const IDENTIFIER_LIMITS = {
  providerId: 64,
  externalTransactionId: 128,
  referenceExternalTransactionId: 128,
  playerId: 128,
  roundId: 128,
  gameId: 128,
  idempotencyKey: 255,
  consumerName: 80,
  messageId: 128,
} as const;

// Lowercase only: the canonical form this service issues and PostgreSQL returns. An uppercase
// id would find its row and then differ, as a string, from the id read back.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// No identifier needs a control character, and PostgreSQL text cannot hold NUL. MikroORM writes
// values into the SQL text, where a NUL would even end the protocol message early (08P01). An
// unpaired surrogate is not text at all: encoded as UTF-8 it becomes U+FFFD, so two different
// ids would be stored as the same one. U+FFFE and U+FFFF are the characters left that SQS refuses
// in a message: events carry identifiers, and one SQS can never accept would be retried forever,
// holding back every later event of its wallet. The schema checks none of these; only the use
// cases write identifiers.
const UNSUPPORTED_CHARACTER = /[\p{Cc}\p{Cs}\uFFFE\uFFFF]/u;

export type IdentifierPath = keyof typeof IDENTIFIER_LIMITS;

/** Ids the application generates are lowercase UUIDs; anything else can match no row. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Whether the use cases accept the value as this identifier. They never stored a value they
 * refuse, so a refused value matches no row.
 */
export function isIdentifier(path: IdentifierPath, value: string): boolean {
  return identifierIssue(path, value) === undefined;
}

/** What is wrong with the value as this identifier, or undefined when the use cases accept it. */
export function identifierIssue(path: IdentifierPath, value: string): string | undefined {
  const max = IDENTIFIER_LIMITS[path];
  if (value.length === 0 || value.length > max) {
    return `must have 1 to ${max} characters`;
  }
  return UNSUPPORTED_CHARACTER.test(value)
    ? "must not contain control characters, unpaired surrogates, U+FFFE or U+FFFF"
    : undefined;
}

/** Collects every broken rule of a request, then throws them together. */
export class RequestCheck {
  private readonly issues: ValidationIssue[] = [];

  identifier(path: IdentifierPath, value: string | undefined): this {
    const message = value === undefined ? undefined : identifierIssue(path, value);
    if (message !== undefined) {
      this.issues.push({ path, message });
    }
    return this;
  }

  uuid(path: string, value: string): this {
    if (!isUuid(value)) {
      this.issues.push({ path, message: "must be a lowercase UUID" });
    }
    return this;
  }

  /** Throws `InvalidRequestError` with every issue found, if any. */
  verify(): void {
    if (this.issues.length > 0) {
      throw new InvalidRequestError(this.issues);
    }
  }
}
