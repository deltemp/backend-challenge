import { WagerTransactionFailed } from "../../domain/events/events";
import type { ReferenceRetryPolicy } from "../../domain/wagering/wager-rules";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { DuplicateKeyError, TransientError } from "../errors";
import { decisionEvents, enqueueEvents, eventContexts } from "../integration-events";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { Repositories } from "../ports/repositories";
import type { UnitOfWork } from "../ports/unit-of-work";
import { type WagerTransactionView, wagerTransactionView } from "../views";
import { ledgerEntryOf, processWager } from "../wager-processing";

export interface ReprocessPendingReferenceCommand {
  readonly transactionId: string;
  readonly correlationId: string;
}

export type ReprocessSkipReason = "not-found" | "wallet-busy" | "not-pending" | "not-due";

export type ReprocessResult =
  | {
      /** `rescheduled`: the reference is still missing or pending; the next attempt is set. */
      readonly status: "processed" | "rejected" | "rescheduled";
      readonly transaction: WagerTransactionView;
    }
  | {
      readonly status: "failed";
      readonly transaction: WagerTransactionView;
      /** The unrecoverable error, for the worker to log. */
      readonly error: unknown;
    }
  | { readonly status: "skipped"; readonly reason: ReprocessSkipReason };

/**
 * Gives a parked transaction another attempt: applies it once its reference is PROCESSED,
 * rejects it when the reference ended badly or the deadline passed with no reference, or
 * schedules the next attempt. The wallet is locked first (skipped when another transaction holds
 * it) and the transaction read again under that lock, so concurrent workers never apply it
 * twice. An unexpected, non-transient error marks it FAILED, with its event; a transient one
 * leaves it parked for a later attempt. A violation of the reversal index runs it once more.
 */
export class ReprocessPendingReference {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy,
  ) {}

  async execute(command: ReprocessPendingReferenceCommand): Promise<ReprocessResult> {
    try {
      return await this.attempt(command);
    } catch (error) {
      if (!(error instanceof DuplicateKeyError && error.key === "reversal")) {
        return await this.recover(command, error);
      }
    }
    // Every reversal runs under the lock of its reference's wallet and looks for an earlier one
    // first, so this violation is no genuine race. Running once more settles it either way: a
    // reversal committed in between is now seen and rejects this one, and a second violation is
    // a bug, which ends FAILED. Left parked, it would fail the same way at every attempt.
    try {
      return await this.attempt(command);
    } catch (error) {
      return await this.recover(command, error);
    }
  }

  private attempt(command: ReprocessPendingReferenceCommand): Promise<ReprocessResult> {
    return this.unitOfWork.run((repositories) => this.reprocess(repositories, command));
  }

  /**
   * A transient failure leaves the transaction parked for the worker's next round; anything
   * else, any duplicate key included, is a bug and marks it FAILED.
   */
  private async recover(
    command: ReprocessPendingReferenceCommand,
    error: unknown,
  ): Promise<ReprocessResult> {
    if (error instanceof TransientError) {
      throw error;
    }
    return this.fail(command, error);
  }

  private async reprocess(
    repositories: Repositories,
    command: ReprocessPendingReferenceCommand,
  ): Promise<ReprocessResult> {
    const { transactions, wallets } = repositories;
    const parked = await transactions.find(command.transactionId);
    if (parked === undefined) {
      return { status: "skipped", reason: "not-found" };
    }
    const wallet = await wallets.lockIfFree(parked.walletId);
    if (wallet === undefined) {
      return { status: "skipped", reason: "wallet-busy" };
    }
    // Read again under the wallet lock: another worker may have handled it in the meantime.
    const transaction = await transactions.find(command.transactionId);
    if (transaction?.status !== WagerTransactionStatus.PendingReference) {
      return { status: "skipped", reason: "not-pending" };
    }
    const now = this.clock.now();
    if (transaction.nextAttemptAt !== undefined && transaction.nextAttemptAt > now) {
      return { status: "skipped", reason: "not-due" };
    }

    const outcome = await processWager(repositories, {
      wallet,
      transaction,
      retryPolicy: this.referenceRetry,
      ids: this.ids,
      now,
    });
    await transactions.save(transaction);
    // A new attempt scheduled raises no event: the parking already did.
    await enqueueEvents(
      repositories.outbox,
      decisionEvents(
        transaction,
        wallet,
        ledgerEntryOf(outcome),
        eventContexts(this.ids, now, command.correlationId),
      ),
    );
    const view = wagerTransactionView(transaction);
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        return { status: "processed", transaction: view };
      case WagerTransactionStatus.Rejected:
        return { status: "rejected", transaction: view };
      case WagerTransactionStatus.PendingReference:
        return { status: "rescheduled", transaction: view };
    }
  }

  /** Marks the transaction FAILED in a new unit of work, after the failed one rolled back. */
  private async fail(command: ReprocessPendingReferenceCommand, cause: unknown) {
    const failed = await this.unitOfWork.run(async (repositories) => {
      const parked = await repositories.transactions.find(command.transactionId);
      if (parked === undefined) {
        return undefined;
      }
      if ((await repositories.wallets.lock(parked.walletId)) === undefined) {
        return undefined;
      }
      const transaction = await repositories.transactions.find(command.transactionId);
      if (transaction?.status !== WagerTransactionStatus.PendingReference) {
        return undefined;
      }
      const now = this.clock.now();
      transaction.fail(now);
      await repositories.transactions.save(transaction);
      const context = eventContexts(this.ids, now, command.correlationId);
      await enqueueEvents(repositories.outbox, [
        WagerTransactionFailed.from(transaction, context()),
      ]);
      return transaction;
    });
    if (failed === undefined) {
      throw cause;
    }
    return { status: "failed", transaction: wagerTransactionView(failed), error: cause } as const;
  }
}
