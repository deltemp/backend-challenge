/**
 * A use case failure the caller must handle, with the stable code of the protocol contract
 * (AGENTS.md, "HTTP contract"). Business rejections are not errors: they are stored outcomes.
 * Messages carry ids, never amounts or balances.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

// Not-found messages never echo the id: it is caller input, possibly malformed, and messages
// reach the logs and the problem details.

export class WalletNotFoundError extends ApplicationError {
  override readonly code = "WALLET_NOT_FOUND";

  constructor(readonly walletId: string) {
    super("the wallet does not exist");
  }
}

export class TransactionNotFoundError extends ApplicationError {
  override readonly code = "TRANSACTION_NOT_FOUND";

  constructor() {
    super("the transaction does not exist");
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = "WALLET_ALREADY_EXISTS";

  /** The wallet that already exists for the player and currency. */
  constructor(readonly walletId: string | undefined) {
    super("a wallet already exists for this player and currency");
  }
}

/** The idempotency key was used before, with a different payload: never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  override readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly transactionId: string) {
    super(`the idempotency key was used by transaction ${transactionId} with another payload`);
  }
}

/** The provider's transaction id was used before, under another idempotency key. */
export class ExternalTransactionConflictError extends ApplicationError {
  override readonly code = "EXTERNAL_TRANSACTION_CONFLICT";

  constructor(readonly transactionId: string) {
    super(`the provider's transaction id belongs to transaction ${transactionId}`);
  }
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A field breaks the contract (`VALIDATION_FAILED`): a malformed id or a value longer than the
 * schema allows. The interfaces validate first; this keeps such input from ever reaching the
 * database as an unclassified error.
 */
export class InvalidRequestError extends ApplicationError {
  override readonly code = "VALIDATION_FAILED";

  constructor(readonly errors: readonly ValidationIssue[]) {
    super(`invalid request: ${errors.map((issue) => issue.path).join(", ")}`);
  }
}

/**
 * A queue message id was processed before with another payload. Queue-only and permanent: the
 * message is never processed and never answered as a replay.
 */
export class InboxConflictError extends ApplicationError {
  override readonly code = "INBOX_CONFLICT";

  constructor(readonly messageId: string) {
    super(`message ${messageId} was processed before with another payload`);
  }
}

export class InvalidCursorError extends ApplicationError {
  override readonly code = "INVALID_CURSOR";

  constructor() {
    super("the cursor was not issued by this service");
  }
}

/** Nothing was committed: resending with the same idempotency key is safe. */
export abstract class TransientError extends ApplicationError {}

/** `lock_timeout` while waiting for a contended wallet. */
export class WalletBusyError extends TransientError {
  override readonly code = "WALLET_BUSY";

  constructor(options?: ErrorOptions) {
    super("the wallet is busy: retry later", options);
  }
}

/** PostgreSQL or SQS unreachable, or a statement timeout. */
export class DependencyUnavailableError extends TransientError {
  override readonly code = "DEPENDENCY_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("a dependency is unavailable: retry later", options);
  }
}

/** The unique keys a use case can race on, named by meaning rather than by constraint. */
export type DuplicateKey =
  | "wallet-owner"
  | "idempotency-key"
  | "external-transaction"
  | "inbox-message"
  | "reversal"
  | "other";

/**
 * A concurrent transaction committed the same unique key first. Never reaches a caller: the
 * use case runs once more, finds the committed row, and answers from it.
 */
export class DuplicateKeyError extends Error {
  override readonly name = "DuplicateKeyError";

  constructor(
    readonly key: DuplicateKey,
    options?: ErrorOptions,
  ) {
    super(`duplicate key: ${key}`, options);
  }
}
