import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../shared/errors";

/** Wire shape of an amount: a decimal string with exactly two places, and an ISO-4217 code. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Amounts are persisted as NUMERIC(20,2): at most 18 integer digits and 2 decimal places.
// decimal.js keeps 20 significant digits by default, which cannot add two amounts at that limit
// exactly, so Money uses its own configuration with room to spare. Nothing is ever rounded:
// every input has at most two decimal places, and sums and differences keep it that way.
const ExactDecimal = Decimal.clone({ precision: 40, toExpNeg: -40, toExpPos: 40 });
const SCALE = 2;
const LIMIT = new ExactDecimal("999999999999999999.99");
const AMOUNT_INPUT = /^\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Returns the code when it is shaped like an ISO-4217 currency code: three capital letters. */
export function validateCurrency(currency: string): string {
  if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
    throw new InvalidMoneyError("invalid currency: expected an ISO-4217 code");
  }
  return currency;
}

/** An exact amount in one currency. Immutable: every operation returns a new instance. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  /**
   * Parses an amount from an input contract: a non-negative decimal string with at most two
   * decimal places. `NaN`, `Infinity`, scientific notation, signs, blanks and extra decimal places
   * are rejected, never rounded.
   */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== "string" || !AMOUNT_INPUT.test(props.amount)) {
      throw new InvalidMoneyError(
        "invalid amount: expected a non-negative decimal string with at most 2 decimal places",
      );
    }
    return Money.of(new ExactDecimal(props.amount), validateCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return Money.of(new ExactDecimal(0), validateCurrency(currency));
  }

  /** The amount as a decimal string with exactly two places. */
  get amount(): string {
    // `-0` (the negation of zero) serializes as zero.
    return this.value.isZero() ? "0.00" : this.value.toFixed(SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Equal amounts in the same currency. Amounts in different currencies are never equal. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(LIMIT)) {
      throw new InvalidMoneyError("amount out of range: at most 18 integer digits");
    }
    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}
