import { LedgerDirection } from "../ledger/ledger-direction";
import { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { CurrencyMismatchError, InvariantViolationError } from "../shared/errors";

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A movement of the wallet balance, and the ledger entry that records it. */
export interface WalletMovement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  /** The other side of the double entry: a provider settlement account. */
  readonly counterAccountId: string;
  readonly at: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openedAt: Date;
  /** Required exactly when the initial balance is above zero: the internal OPENING credit. */
  readonly opening?:
    | {
        readonly transactionId: string;
        readonly entryId: string;
        readonly fundingAccountId: string;
      }
    | undefined;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** The OPENING credit, present when the wallet opens with a balance above zero. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root that owns a player's balance in one currency.
 *
 * - The balance never goes negative.
 * - Every balance change produces exactly one ledger entry, and every entry comes from one.
 * - `version` is 1 once the wallet is open (an OPENING credit is part of the opening) and
 *   advances by exactly one with each balance change, never otherwise.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, opening } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError("a wallet cannot open with a negative balance");
    }
    const zero = Money.zero(initialBalance.currency);
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      zero,
      1,
      props.openedAt,
      props.openedAt,
    );

    if (initialBalance.isZero()) {
      if (opening !== undefined) {
        throw new InvariantViolationError("a wallet opened at zero has no OPENING credit");
      }
      return { wallet, openingEntry: undefined };
    }
    if (opening === undefined) {
      throw new InvariantViolationError("a wallet opened above zero needs its OPENING credit");
    }
    // The OPENING credit is part of the opening, so the version stays at 1.
    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: wallet.id,
      walletVersion: 1,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: zero,
      balanceAfter: initialBalance,
      debitAccountId: opening.fundingAccountId,
      creditAccountId: wallet.accountId,
      createdAt: props.openedAt,
    });
    wallet._balance = initialBalance;
    return { wallet, openingEntry };
  }

  /** Rebuilds a persisted wallet without validating it again. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** The wallet's own ledger account shares its id. */
  get accountId(): string {
    return this.id;
  }

  /** Whether a debit of `money` keeps the balance at zero or above. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /**
   * Lowers the balance and returns the entry that records it. Callers decide the business
   * outcome with `canDebit` first: a debit beyond the balance breaks an invariant.
   */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement);
    if (!this.canDebit(movement.money)) {
      throw new InvariantViolationError("a debit cannot take the balance below zero");
    }
    return this.move(LedgerDirection.Debit, movement);
  }

  /** Raises the balance and returns the entry that records it. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovement(movement);
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);
    const version = this._version + 1;
    const credited = direction === LedgerDirection.Credit;

    // The entry is validated before the wallet changes, so a failure leaves the wallet intact.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      walletVersion: version,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      debitAccountId: credited ? movement.counterAccountId : this.accountId,
      creditAccountId: credited ? this.accountId : movement.counterAccountId,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version = version;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertMovement(movement: WalletMovement): void {
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvariantViolationError("a balance movement must be positive");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet ${this.id} holds ${this.currency}, not ${money.currency}`,
      );
    }
  }
}
