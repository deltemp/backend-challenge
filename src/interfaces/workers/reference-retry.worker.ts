import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Logger } from "pino";
import { TransientError, WalletBusyError } from "../../application/errors";
import type { ReprocessResult } from "../../application/use-cases/reprocess-pending-reference";
import { FullJitterBackoff } from "../../domain/shared/backoff";
import type { AppConfig } from "../../infrastructure/config/config";
import { APP_CONFIG } from "../../infrastructure/config/config.module";
import { LOGGER } from "../../infrastructure/observability/logger";
import { Metrics } from "../../infrastructure/observability/metrics";
import {
  annotateContext,
  requestContext,
} from "../../infrastructure/observability/request-context";
import { mathRandom } from "../../infrastructure/runtime";
import type { UseCases } from "../../infrastructure/use-cases";
import { USE_CASES } from "../../infrastructure/use-cases.module";
import { elapsedSeconds, sleep } from "../background";
import { WageringTelemetry } from "../telemetry";

/** Progress: an outcome was decided or rescheduled. Idle: nothing due, or only skips. */
type Round = "progress" | "idle" | "transient";

/**
 * Reprocesses the parked (`PENDING_REFERENCE`) transactions that are due, on every instance with
 * the `retry` role. Within a process it takes them oldest first and one at a time, so a chain
 * (the ROLLBACK of a REFUND whose BET is late) resolves in order. Instances never apply one twice:
 * `ReprocessPendingReference` locks the wallet with `SKIP LOCKED` and reads the transaction again.
 *
 * A round that only skipped busy wallets, or failed transiently, leaves `next_attempt_at` as it
 * was, so the loop paces itself instead of spinning on the same rows. A busy wallet is skipped,
 * never waited for, so one hot wallet cannot hold back the transactions behind it; only an
 * unavailable dependency ends the round.
 */
@Injectable()
export class ReferenceRetryWorker
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly stopping = new AbortController();
  private readonly backoff: FullJitterBackoff;
  private running: Promise<void> | undefined;

  constructor(
    @Inject(USE_CASES) private readonly useCases: UseCases,
    private readonly telemetry: WageringTelemetry,
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.backoff = FullJitterBackoff.create({ ...config.outageBackoff, random: mathRandom });
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  // Every loop is aborted in onModuleDestroy, which NestJS runs for all modules first; each is
  // then awaited in beforeApplicationShutdown, which it runs one module after another.
  onModuleDestroy(): void {
    this.stopping.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.running;
  }

  private async run(): Promise<void> {
    const signal = this.stopping.signal;
    const { batchSize, pollIntervalMs } = this.config.referenceRetry;
    this.logger.info("reference retry worker started");
    let failures = 0;
    while (!signal.aborted) {
      let round: Round;
      try {
        const due = await this.useCases.findDuePendingReferences.execute({ limit: batchSize });
        round = await this.reprocess(due, signal);
      } catch (error) {
        this.logger.warn({ err: error }, "could not list the parked transactions that are due");
        round = "transient";
      }
      failures = round === "transient" ? failures + 1 : 0;
      if (round === "idle") {
        await sleep(pollIntervalMs, signal);
      } else if (round === "transient") {
        await sleep(this.backoff.delayMs(failures - 1), signal);
      }
    }
    this.logger.info("reference retry worker stopped");
  }

  private async reprocess(due: readonly string[], signal: AbortSignal): Promise<Round> {
    let progress = false;
    for (const transactionId of due) {
      if (signal.aborted) {
        break;
      }
      const correlationId = Bun.randomUUIDv7();
      const outcome = await requestContext.run({ correlationId, transactionId }, () =>
        this.reprocessOne(transactionId, correlationId),
      );
      if (outcome === "transient") {
        return "transient";
      }
      progress ||= outcome === "progress";
    }
    return progress ? "progress" : "idle";
  }

  private async reprocessOne(
    transactionId: string,
    correlationId: string,
  ): Promise<"progress" | "skipped" | "transient"> {
    const startedAt = performance.now();
    let result: ReprocessResult;
    try {
      result = await this.useCases.reprocessPendingReference.execute({
        transactionId,
        correlationId,
      });
    } catch (error) {
      if (error instanceof WalletBusyError) {
        // Like a SKIP LOCKED skip: the wallet is contended, the next transaction may not be.
        this.metrics.lockConflicts.inc({ source: "retry" });
        this.logger.warn({ err: error }, "a parked transaction met a busy wallet: retried later");
        return "skipped";
      }
      if (error instanceof TransientError) {
        this.logger.warn({ err: error }, "a parked transaction will be retried later");
        return "transient";
      }
      // The transaction was decided elsewhere before it could be marked FAILED: a bug to look
      // into, but nothing is left to do for this transaction.
      this.metrics.unexpectedErrors.inc({ component: "reference_retry" });
      this.logger.error({ err: error }, "unexpected error while reprocessing a parked transaction");
      return "skipped";
    }
    this.telemetry.reprocessed(result, elapsedSeconds(startedAt));
    this.log(result);
    return result.status === "skipped" ? "skipped" : "progress";
  }

  private log(result: ReprocessResult): void {
    if (result.status === "skipped") {
      this.logger.debug({ reason: result.reason }, "parked transaction skipped");
      return;
    }
    const { transaction } = result;
    annotateContext({ walletId: transaction.walletId });
    const fields = { status: transaction.status, failureCode: transaction.failureCode };
    if (result.status === "failed") {
      this.logger.error({ ...fields, err: result.error }, "parked transaction marked FAILED");
    } else if (result.status === "rescheduled") {
      this.logger.debug(fields, "parked transaction rescheduled: its reference is still missing");
    } else {
      this.logger.info(fields, "parked transaction decided");
    }
  }
}
