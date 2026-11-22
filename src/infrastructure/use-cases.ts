import type { MikroORM } from "@mikro-orm/postgresql";
import { type WageringSettings, wageringPolicies } from "../application/policies";
import type { Clock } from "../application/ports/clock";
import type { EventPublisher } from "../application/ports/event-publisher";
import type { IdGenerator } from "../application/ports/id-generator";
import type { UnitOfWork } from "../application/ports/unit-of-work";
import { FindDuePendingReferences } from "../application/use-cases/find-due-pending-references";
import { OpenWallet } from "../application/use-cases/open-wallet";
import { PublishOutbox } from "../application/use-cases/publish-outbox";
import {
  GetWagerTransaction,
  GetWallet,
  GetWalletLedger,
  ReconcileWallet,
} from "../application/use-cases/queries";
import { ReprocessPendingReference } from "../application/use-cases/reprocess-pending-reference";
import { SubmitWagerTransaction } from "../application/use-cases/submit-wager-transaction";
import type { RandomSource } from "../domain/shared/backoff";
import { MikroOrmUnitOfWork } from "./mikro-orm/unit-of-work";
import { mathRandom, systemClock, uuidV7Ids } from "./runtime";

export interface UseCases {
  readonly openWallet: OpenWallet;
  readonly submitWagerTransaction: SubmitWagerTransaction;
  readonly findDuePendingReferences: FindDuePendingReferences;
  readonly reprocessPendingReference: ReprocessPendingReference;
  readonly publishOutbox: PublishOutbox;
  readonly getWallet: GetWallet;
  readonly getWalletLedger: GetWalletLedger;
  readonly getWagerTransaction: GetWagerTransaction;
  readonly reconcileWallet: ReconcileWallet;
}

export interface UseCaseDependencies {
  /** An ORM opened for the application (with the session timeouts). */
  readonly orm: MikroORM;
  readonly settings: WageringSettings;
  readonly publisher: EventPublisher;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly random?: RandomSource;
  /** Replaces the MikroORM unit of work, for fault injection in tests. */
  readonly unitOfWork?: UnitOfWork;
}

/** The composition root of the application layer: real adapters unless a test replaces them. */
export function createUseCases(dependencies: UseCaseDependencies): UseCases {
  const clock = dependencies.clock ?? systemClock;
  const ids = dependencies.ids ?? uuidV7Ids;
  const policies = wageringPolicies(dependencies.settings, dependencies.random ?? mathRandom);
  const unitOfWork =
    dependencies.unitOfWork ?? new MikroOrmUnitOfWork(dependencies.orm, ids, clock);
  return {
    openWallet: new OpenWallet(unitOfWork, clock, ids),
    submitWagerTransaction: new SubmitWagerTransaction(
      unitOfWork,
      clock,
      ids,
      policies.referenceRetry,
    ),
    findDuePendingReferences: new FindDuePendingReferences(unitOfWork, clock),
    reprocessPendingReference: new ReprocessPendingReference(
      unitOfWork,
      clock,
      ids,
      policies.referenceRetry,
    ),
    publishOutbox: new PublishOutbox(
      unitOfWork,
      clock,
      dependencies.publisher,
      policies.outboxRetry,
    ),
    getWallet: new GetWallet(unitOfWork),
    getWalletLedger: new GetWalletLedger(unitOfWork),
    getWagerTransaction: new GetWagerTransaction(unitOfWork),
    reconcileWallet: new ReconcileWallet(unitOfWork),
  };
}
