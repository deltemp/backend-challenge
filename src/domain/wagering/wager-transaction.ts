import { LedgerDirection, oppositeDirection } from "../ledger/ledger-direction";
import type { Money } from "../money/money";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  InvariantViolationError,
} from "../shared/errors";
import { FailureCode, type RejectionCode } from "./failure-code";

export enum WagerTransactionKind {
  /** Internal: the credit of a wallet's initial balance. Never submitted by a provider. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Accepted, not applied yet. Never leaves the SQL transaction that creates it. */
  Pending = "PENDING",
  /** Waiting for its reference to arrive or to settle. */
  PendingReference = "PENDING_REFERENCE",
  /** Applied. Terminal. */
  Processed = "PROCESSED",
  /** Rejected by a business rule. Terminal. */
  Rejected = "REJECTED",
  /** An unrecoverable infrastructure failure while reprocessing. Terminal and auditable. */
  Failed = "FAILED",
}

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];
const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];
const PAYLOAD_HASH = /^[0-9a-f]{64}$/;

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** The provider's id of the referenced transaction. */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface OpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly createdAt: Date;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly processedAt: Date | undefined;
  readonly observedBalance: Money | undefined;
  readonly referenceDeadline: Date | undefined;
  readonly nextAttemptAt: Date | undefined;
  readonly referenceAttempts: number;
  readonly updatedAt: Date;
}

/**
 * A wagering operation and its outcome.
 *
 * Valid transitions: PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE, and
 * PENDING_REFERENCE → PROCESSED | REJECTED | FAILED. PROCESSED, REJECTED and FAILED are
 * terminal: transitioning from them throws `InvalidTransactionStateError`.
 *
 * The outcome keeps a snapshot of the balance observed when it was decided, so a replay returns
 * the original result rather than the current balance.
 */
export class WagerTransaction {
  readonly id: string;
  /** Undefined only for the internal OPENING credit, like the other provider fields. */
  readonly providerId: string | undefined;
  readonly externalTransactionId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payloadHash: string | undefined;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string | undefined;
  readonly gameId: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** The provider's id of the referenced transaction, not the internal one. */
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _referenceDeadline: Date | undefined;
  private _nextAttemptAt: Date | undefined;
  private _referenceAttempts: number;
  private _updatedAt: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._observedBalance = state.observedBalance;
    this._referenceDeadline = state.referenceDeadline;
    this._nextAttemptAt = state.nextAttemptAt;
    this._referenceAttempts = state.referenceAttempts;
    this._updatedAt = state.updatedAt;
  }

  /**
   * A transaction submitted by a provider. It starts PENDING. REFUND and ROLLBACK need a
   * reference, WIN and LOSS may carry one, BET never does. Amounts are positive, except that a
   * LOSS may record zero.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    for (const [field, value] of [
      ["providerId", props.providerId],
      ["externalTransactionId", props.externalTransactionId],
      ["idempotencyKey", props.idempotencyKey],
      ["walletId", props.walletId],
      ["playerId", props.playerId],
      ["roundId", props.roundId],
      ["gameId", props.gameId],
    ] as const) {
      if (value.length === 0) {
        throw new InvalidWagerTransactionError(`${field} must not be empty`);
      }
    }
    if (!PAYLOAD_HASH.test(props.payloadHash)) {
      throw new InvariantViolationError("payloadHash must be a hex SHA-256 digest");
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.length === 0) {
      throw new InvalidWagerTransactionError("referenceExternalTransactionId must not be empty");
    }
    if (REVERSAL_KINDS.includes(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} needs referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError("a BET cannot reference another transaction");
    }
    if (
      props.kind === WagerTransactionKind.Loss
        ? props.money.isNegative()
        : !props.money.isPositive()
    ) {
      throw new InvalidWagerTransactionError(
        props.kind === WagerTransactionKind.Loss
          ? "a LOSS amount cannot be negative"
          : `a ${props.kind} amount must be greater than zero`,
      );
    }

    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceDeadline: undefined,
      nextAttemptAt: undefined,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /**
   * The internal credit of a wallet's initial balance. It is applied atomically with the wallet's
   * opening, so it is born PROCESSED, with the initial balance as its observed balance.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("an OPENING credit is positive");
    }
    return new WagerTransaction({
      id: props.id,
      providerId: undefined,
      externalTransactionId: undefined,
      idempotencyKey: undefined,
      payloadHash: undefined,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: props.createdAt,
      observedBalance: props.money,
      referenceDeadline: undefined,
      nextAttemptAt: undefined,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Rebuilds a persisted transaction without validating its transitions again. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** The wallet balance observed when the outcome was decided; absent for wallet mismatches. */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** Receipt plus the reference TTL, fixed when the transaction is first parked. */
  get referenceDeadline(): Date | undefined {
    return this._referenceDeadline;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  /** Reprocessing attempts made while waiting for the reference. */
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions -------------------------------------------------------------------------

  markProcessed(props: {
    readonly referenceTransactionId: string | undefined;
    readonly observedBalance: Money;
    readonly at: Date;
  }): void {
    this.assertNotTerminal();
    if (this.hasReference() !== (props.referenceTransactionId !== undefined)) {
      throw new InvariantViolationError(
        "a processed transaction records the internal id of its reference, and only then",
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._observedBalance = props.observedBalance;
    this._processedAt = props.at;
    this._nextAttemptAt = undefined;
    this._updatedAt = props.at;
  }

  markPendingReference(props: {
    readonly deadline: Date;
    readonly nextAttemptAt: Date;
    readonly observedBalance: Money;
    readonly at: Date;
  }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} is ${this._status}: only a PENDING transaction can be parked`,
      );
    }
    if (!this.hasReference()) {
      throw new InvariantViolationError("only a transaction with a reference can wait for it");
    }
    if (props.nextAttemptAt > props.deadline) {
      throw new InvariantViolationError("the next attempt cannot come after the deadline");
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceDeadline = props.deadline;
    this._nextAttemptAt = props.nextAttemptAt;
    this._observedBalance = props.observedBalance;
    this._updatedAt = props.at;
  }

  /** Records a reprocessing attempt that could not resolve the reference yet. */
  scheduleReferenceRetry(props: { readonly nextAttemptAt: Date; readonly at: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} is ${this._status}: only a parked transaction is retried`,
      );
    }
    if (this._referenceDeadline === undefined || props.nextAttemptAt > this._referenceDeadline) {
      throw new InvariantViolationError("the next attempt cannot come after the deadline");
    }
    this._referenceAttempts += 1;
    this._nextAttemptAt = props.nextAttemptAt;
    this._updatedAt = props.at;
  }

  reject(
    code: RejectionCode,
    props: { readonly observedBalance: Money | undefined; readonly at: Date },
  ): void {
    this.assertNotTerminal();
    if ((code as FailureCode) === FailureCode.InternalError) {
      throw new InvariantViolationError(
        "INTERNAL_ERROR marks a FAILED transaction, not a rejection",
      );
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = props.observedBalance;
    this._nextAttemptAt = undefined;
    this._updatedAt = props.at;
  }

  /** An unrecoverable, non-business failure. Always carries INTERNAL_ERROR. */
  fail(at: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = FailureCode.InternalError;
    this._nextAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- queries ----------------------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** False for LOSS, which records an outcome without moving the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** True for REFUND and ROLLBACK. */
  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** The wallet side of this transaction's ledger entry. A ROLLBACK mirrors its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvariantViolationError("a ROLLBACK's direction comes from its reference");
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError("a LOSS does not move the balance");
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `transaction ${this.id} is ${this._status}, a terminal state`,
      );
    }
  }
}
