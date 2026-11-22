/**
 * Runs every cleanup step in order, even when an earlier one fails, then reports all failures
 * together. Steps for resources that were never created should resolve to nothing, for example
 * `() => app?.stop()`.
 */
export async function cleanUp(...steps: Array<() => unknown>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} cleanup steps failed`);
  }
}
