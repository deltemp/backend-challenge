import { describe, expect, test } from "bun:test";
import { FullJitterBackoff } from "../../../src/domain/shared/backoff";
import { at } from "./fixtures";

const ALMOST_ONE = () => 0.999_999;
const ZERO = () => 0;

describe("FullJitterBackoff", () => {
  test("draws each delay uniformly from [0, min(cap, base × 2^retry))", () => {
    const highest = FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: ALMOST_ONE });
    const lowest = FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: ZERO });

    expect([0, 1, 2, 3, 4, 5, 6, 7].map((retry) => highest.delayMs(retry))).toEqual([
      999, 1999, 3999, 7999, 15_999, 31_999, 59_999, 59_999,
    ]);
    expect(lowest.delayMs(5)).toBe(0);
  });

  test("stays at the cap for any retry number, without overflowing", () => {
    const backoff = FullJitterBackoff.create({ baseMs: 5000, capMs: 60_000, random: ALMOST_ONE });

    expect(backoff.delayMs(10_000)).toBe(59_999);
  });

  test("treats a negative retry number as the first retry", () => {
    const backoff = FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: ALMOST_ONE });

    expect(backoff.delayMs(-3)).toBe(backoff.delayMs(0));
  });

  test("uses the injected randomness, so successive delays differ", () => {
    const values = [0.1, 0.9];
    const backoff = FullJitterBackoff.create({
      baseMs: 1000,
      capMs: 60_000,
      random: () => values.shift() ?? 0,
    });

    expect([backoff.delayMs(3), backoff.delayMs(3)]).toEqual([800, 7200]);
  });

  test("never schedules an attempt past the deadline", () => {
    const backoff = FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: ALMOST_ONE });

    expect(backoff.nextAttemptAt(at(0), 6, at(0.5))).toEqual(at(0.5));
    expect(backoff.nextAttemptAt(at(0), 0, at(10))).toEqual(new Date(at(0).getTime() + 999));
    expect(backoff.nextAttemptAt(at(0), 6)).toEqual(new Date(at(0).getTime() + 59_999));
  });

  test.each([
    [0, 1000],
    [-1, 1000],
    [Number.NaN, 1000],
    [1000, Number.POSITIVE_INFINITY],
    [2000, 1000],
  ])("refuses base %p and cap %p", (base, cap) => {
    expect(() => FullJitterBackoff.create({ baseMs: base, capMs: cap, random: ZERO })).toThrow(
      RangeError,
    );
  });
});
