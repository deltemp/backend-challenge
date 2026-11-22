export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** Rejects with {@link TimeoutError} when the promise does not settle within the given time. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
