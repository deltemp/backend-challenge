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
// PostgreSQL text cannot hold NUL, and no identifier needs any control character.
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Ids the application generates are lowercase UUIDs; anything else can match no row. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Collects every broken rule of a request, then throws them together. */
export class RequestCheck {
  private readonly issues: ValidationIssue[] = [];

  identifier(path: keyof typeof IDENTIFIER_LIMITS, value: string | undefined): this {
    const max = IDENTIFIER_LIMITS[path];
    if (value === undefined) {
      return this;
    }
    if (value.length === 0 || value.length > max) {
      this.issues.push({ path, message: `must have 1 to ${max} characters` });
    } else if (CONTROL_CHARACTER.test(value)) {
      this.issues.push({ path, message: "must not contain control characters" });
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
