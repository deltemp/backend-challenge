/** The current time. Injected, so deadlines and backoff are deterministic in tests. */
export interface Clock {
  now(): Date;
}
