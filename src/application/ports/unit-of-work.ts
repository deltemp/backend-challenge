import type { Repositories } from "./repositories";

/**
 * One use case, one SQL transaction. `run` commits when `work` resolves and rolls back when it
 * throws; the deferred schema checks run at the commit. Infrastructure failures surface as
 * `WalletBusyError`, `DependencyUnavailableError` (both transient) or `DuplicateKeyError`.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
