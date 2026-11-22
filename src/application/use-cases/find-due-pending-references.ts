import type { Clock } from "../ports/clock";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface FindDuePendingReferencesQuery {
  readonly limit: number;
}

/**
 * Ids of the parked transactions due for another attempt, oldest first, so a chain resolves in
 * order. Locks nothing: `ReprocessPendingReference` locks the wallet and checks again.
 */
export class FindDuePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(query: FindDuePendingReferencesQuery): Promise<string[]> {
    return this.unitOfWork.run(({ transactions }) =>
      transactions.findDuePendingReferences(this.clock.now(), query.limit),
    );
  }
}
