import type { Money } from "../money/money";
import { InvariantViolationError } from "../shared/errors";
import { LedgerDirection } from "./ledger-direction";

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  /** The wallet version this movement produced. */
  readonly walletVersion: number;
  readonly transactionId: string;
  /** The wallet side of the movement. */
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * One movement of the double-entry ledger: the account debited, the account credited and a
 * positive amount, so the row is balanced by construction. It also records the wallet side of
 * the movement, which makes every entry verifiable on its own.
 *
 * Immutable by structure: every field is read-only, the instance is frozen, and there is no
 * transition method.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly walletVersion: number;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly createdAt: Date;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.walletVersion = state.walletVersion;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.debitAccountId = state.debitAccountId;
    this.creditAccountId = state.creditAccountId;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  /** Creates an entry, checking its arithmetic and the consistency of its two sides. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("a ledger entry moves a positive amount");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError("a wallet balance is never negative");
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError("a wallet version is a positive integer");
    }
    if (props.debitAccountId === props.creditAccountId) {
      throw new InvariantViolationError("the debited and credited accounts must differ");
    }
    const walletSide =
      props.direction === LedgerDirection.Debit ? props.debitAccountId : props.creditAccountId;
    if (walletSide !== props.walletId) {
      throw new InvariantViolationError(
        "the wallet is the debited account of a DEBIT and the credited account of a CREDIT",
      );
    }
    // Money operations also reject a currency that differs between the amount and the balances.
    if (!entry.isBalanced()) {
      throw new InvariantViolationError("balanceBefore ± money must equal balanceAfter");
    }
    return entry;
  }

  /** Rebuilds a persisted entry without validating it again. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** `balanceBefore ± money === balanceAfter`, with the sign given by the wallet side. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
