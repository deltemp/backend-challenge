import { describe, expect, test } from "bun:test";
import { Money, validateCurrency } from "../../../src/domain/money/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/domain/shared/errors";
import { brl, usd } from "./fixtures";

// §13 unit: operations and validations of Money (scale, rounding, invalid inputs).
describe("Money", () => {
  describe("scale", () => {
    test.each([
      ["25.00", "25.00"],
      ["25", "25.00"],
      ["25.5", "25.50"],
      ["0", "0.00"],
      ["0.01", "0.01"],
      ["007.50", "7.50"],
      ["999999999999999999.99", "999999999999999999.99"],
    ])("reads %p and always writes two decimal places: %p", (input, written) => {
      expect(Money.from({ amount: input, currency: "BRL" }).amount).toBe(written);
    });
  });

  describe("invalid inputs", () => {
    test.each([
      "",
      " ",
      "NaN",
      "Infinity",
      "-Infinity",
      "1e3",
      "1E-2",
      "2.5e1",
      "-1.00",
      "+1.00",
      ".5",
      "5.",
      "1,00",
      " 1.00",
      "1.00 ",
      "0x10",
      "1_000",
    ])("rejects %p", (input) => {
      expect(() => Money.from({ amount: input, currency: "BRL" })).toThrow(InvalidMoneyError);
    });

    test("rejects an amount that is not a string", () => {
      const notAString = 25 as unknown as string;

      expect(() => Money.from({ amount: notAString, currency: "BRL" })).toThrow(InvalidMoneyError);
    });

    test("rejects amounts beyond NUMERIC(20,2)", () => {
      expect(() => Money.from({ amount: "1000000000000000000", currency: "BRL" })).toThrow(
        InvalidMoneyError,
      );
    });

    test.each(["brl", "BR", "BRLL", "", "B1L"])("rejects the currency %p", (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
      expect(() => validateCurrency(currency)).toThrow(InvalidMoneyError);
    });
  });

  describe("rounding", () => {
    test.each(["1.234", "0.001", "10.999"])(
      "never rounds %p: a third decimal place is an error",
      (input) => {
        expect(() => Money.from({ amount: input, currency: "BRL" })).toThrow(InvalidMoneyError);
      },
    );

    test("adds and subtracts exactly, where floating point would drift", () => {
      expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
      expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
      expect(brl("0.30").subtract(brl("0.10")).amount).toBe("0.20");
    });

    test("stays exact at the limit of NUMERIC(20,2), and refuses to go beyond it", () => {
      const nearLimit = brl("999999999999999999.98");

      expect(nearLimit.add(brl("0.01")).amount).toBe("999999999999999999.99");
      expect(() => nearLimit.add(brl("0.02"))).toThrow(InvalidMoneyError);
    });
  });

  describe("operations", () => {
    test("subtracting more than the amount gives a negative result", () => {
      const result = brl("20.00").subtract(brl("80.00"));

      expect(result.isNegative()).toBe(true);
      expect(result.amount).toBe("-60.00");
    });

    test("negates, and the negation of zero is still written as zero", () => {
      expect(brl("25.00").negate().amount).toBe("-25.00");
      expect(Money.zero("BRL").negate().amount).toBe("0.00");
    });

    test("is immutable: operations return new instances", () => {
      const original = brl("10.00");

      original.add(brl("5.00"));
      original.subtract(brl("5.00"));
      original.negate();

      expect(original.amount).toBe("10.00");
    });

    test("compares amounts", () => {
      expect(Money.zero("BRL").isZero()).toBe(true);
      expect(brl("0.01").isPositive()).toBe(true);
      expect(brl("0.01").isNegative()).toBe(false);
      expect(brl("10.00").isLessThan(brl("10.01"))).toBe(true);
      expect(brl("10.00").isLessThan(brl("10.00"))).toBe(false);
      expect(brl("10").equals(brl("10.00"))).toBe(true);
    });
  });

  // §13 unit: currency conflict.
  describe("currency conflicts", () => {
    test("adding, subtracting or comparing across currencies is a domain error", () => {
      expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
      expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
      expect(() => brl("1.00").isLessThan(usd("2.00"))).toThrow(CurrencyMismatchError);
    });

    test("amounts in different currencies are never equal", () => {
      expect(brl("1.00").equals(usd("1.00"))).toBe(false);
    });
  });

  describe("serialization", () => {
    test("writes the contract shape", () => {
      expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
      expect(JSON.stringify({ money: brl("25") })).toBe(
        '{"money":{"amount":"25.00","currency":"BRL"}}',
      );
      expect(brl("25").toString()).toBe("25.00 BRL");
    });
  });
});
