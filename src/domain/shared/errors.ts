/**
 * Base of every domain error. `code` is stable and machine-readable, so the interfaces map each
 * error to a response without parsing messages. Messages never carry amounts or balances.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An amount or a currency that is not a valid `Money` value. */
export class InvalidMoneyError extends DomainError {
  override readonly code = "INVALID_MONEY";
}

/** An operation that combines two currencies. */
export class CurrencyMismatchError extends DomainError {
  override readonly code = "CURRENCY_MISMATCH";
}

/** A submitted transaction that breaks the contract, such as a REFUND without a reference. */
export class InvalidWagerTransactionError extends DomainError {
  override readonly code = "INVALID_WAGER_TRANSACTION";
}

/** A transition from a state that does not allow it. A programming error, not a business path. */
export class InvalidTransactionStateError extends DomainError {
  override readonly code = "INVALID_TRANSACTION_STATE";
}

/**
 * A call that would break an invariant: a negative balance, an unbalanced ledger entry, a
 * message published twice. A programming error, not a business path.
 */
export class InvariantViolationError extends DomainError {
  override readonly code = "INVARIANT_VIOLATION";
}
