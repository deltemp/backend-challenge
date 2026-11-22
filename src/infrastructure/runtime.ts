import type { Clock } from "../application/ports/clock";
import type { IdGenerator } from "../application/ports/id-generator";
import type { RandomSource } from "../domain/shared/backoff";

// The real implementations of the time, id and randomness ports. Domain and application code
// never call `Date`, `Math.random` or an id function directly, so tests can replace these.

export const systemClock: Clock = { now: () => new Date() };

export const uuidV7Ids: IdGenerator = { next: () => Bun.randomUUIDv7() };

export const mathRandom: RandomSource = Math.random;
