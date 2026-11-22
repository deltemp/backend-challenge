/** Uniformly distributed numbers in [0, 1). Injected, so backoff and expiry are testable. */
export type RandomSource = () => number;

/**
 * Exponential backoff with full jitter: the delay before retry `n` (0 for the first retry) is
 * uniformly random in [0, min(cap, base × 2^n)). Spreading retries out keeps a burst of failures
 * from coming back in the same instant.
 */
export class FullJitterBackoff {
  private constructor(
    private readonly baseMs: number,
    private readonly capMs: number,
    private readonly random: RandomSource,
  ) {}

  /** Base and cap in milliseconds, with 0 < base <= cap. */
  static create(props: {
    readonly baseMs: number;
    readonly capMs: number;
    readonly random: RandomSource;
  }): FullJitterBackoff {
    const { baseMs, capMs, random } = props;
    if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(capMs) || capMs < baseMs) {
      throw new RangeError("backoff needs 0 < base <= cap");
    }
    return new FullJitterBackoff(baseMs, capMs, random);
  }

  delayMs(retry: number): number {
    const ceiling = Math.min(this.capMs, this.baseMs * 2 ** Math.max(0, retry));
    return Math.floor(this.random() * ceiling);
  }

  /** When retry `n` should happen, never later than `deadline` when one is given. */
  nextAttemptAt(now: Date, retry: number, deadline?: Date): Date {
    const next = new Date(now.getTime() + this.delayMs(retry));
    return deadline !== undefined && next > deadline ? deadline : next;
  }
}
