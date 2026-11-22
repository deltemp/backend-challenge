/**
 * Polls `probe` until it returns a value other than undefined, and fails after `timeoutMs`.
 * Asynchronous effects (a consumer, a worker, a publisher) are awaited on an observable
 * condition, never on a fixed sleep.
 */
export async function eventually<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  const cause = lastError === undefined ? "" : ` (last error: ${String(lastError)})`;
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}${cause}`);
}
