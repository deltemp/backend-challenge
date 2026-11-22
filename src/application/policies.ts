import { FullJitterBackoff, type RandomSource } from "../domain/shared/backoff";
import type { ReferenceRetryPolicy } from "../domain/wagering/wager-rules";

export interface BackoffSettings {
  readonly baseMs: number;
  readonly capMs: number;
}

/** Configurable retry settings (AGENTS.md, "Retry policies"); tests use short values. */
export interface WageringSettings {
  /** How long a transaction waits for its reference after receipt. */
  readonly referenceTtlMs: number;
  readonly referenceRetry: BackoffSettings;
  readonly outboxRetry: BackoffSettings;
}

export interface WageringPolicies {
  readonly referenceRetry: ReferenceRetryPolicy;
  readonly outboxRetry: FullJitterBackoff;
}

export function wageringPolicies(
  settings: WageringSettings,
  random: RandomSource,
): WageringPolicies {
  return {
    referenceRetry: {
      ttlMs: settings.referenceTtlMs,
      backoff: FullJitterBackoff.create({ ...settings.referenceRetry, random }),
    },
    outboxRetry: FullJitterBackoff.create({ ...settings.outboxRetry, random }),
  };
}
