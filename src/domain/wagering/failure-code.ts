/**
 * Stable, machine-readable reason of a rejection or failure. A public contract: a new code needs
 * a documented reason, and an existing code is never renamed.
 */
export enum FailureCode {
  /** A BET exceeds the balance. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** A ROLLBACK of a WIN or REFUND would make the balance negative. */
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  /** The reference did not arrive before the transaction's deadline. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** The reference belongs to another provider, player, wallet, currency or round. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** The reference is of a kind this operation cannot reference. */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** The reference ended REJECTED or FAILED, or was still pending at the deadline. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** The reference already has a PROCESSED REFUND or ROLLBACK. */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** A reversal's amount differs from its reference's. */
  AmountMismatch = "AMOUNT_MISMATCH",
  /** The operation's currency differs from the wallet's. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** The wallet belongs to another player. */
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  /** An unrecoverable, non-business failure while reprocessing a pending reference. */
  InternalError = "INTERNAL_ERROR",
}

/** The codes of a business rejection: every code but INTERNAL_ERROR, which only FAILED uses. */
export type RejectionCode = Exclude<FailureCode, FailureCode.InternalError>;
