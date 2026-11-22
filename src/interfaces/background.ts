// Helpers shared by the long-running loops: the SQS consumer and the background workers.

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Seconds since `startedAt` (a `performance.now()` reading), for latency metrics. */
export function elapsedSeconds(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}
