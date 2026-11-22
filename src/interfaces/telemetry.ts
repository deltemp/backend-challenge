import { Injectable } from "@nestjs/common";
import type { Attributes } from "@opentelemetry/api";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  WalletBusyError,
} from "../application/errors";
import type { ReprocessResult } from "../application/use-cases/reprocess-pending-reference";
import type { SubmitWagerTransactionResult } from "../application/use-cases/submit-wager-transaction";
import type { WagerTransactionView } from "../application/views";
import { Metrics, type TransactionSource } from "../infrastructure/observability/metrics";
import { inSpan } from "../infrastructure/observability/tracing";

/** What a submission span knows before the use case runs: ids and the kind, never amounts. */
export interface SubmissionTraits {
  readonly providerId: string;
  readonly walletId: string;
  readonly kind: string;
}

/**
 * Records the business metrics and the use-case spans from what the use cases report. The use
 * cases stay free of both; the interfaces that call them know the entry point and translate
 * their results.
 */
@Injectable()
export class WageringTelemetry {
  constructor(private readonly metrics: Metrics) {}

  /** Runs a submission in its use-case span, with the outcome as attributes. */
  traceSubmission(
    source: TransactionSource,
    traits: SubmissionTraits,
    submit: () => Promise<SubmitWagerTransactionResult>,
  ): Promise<SubmitWagerTransactionResult> {
    return inSpan(
      "SubmitWagerTransaction",
      {
        attributes: {
          "wagering.source": source,
          "wagering.provider_id": traits.providerId,
          "wagering.wallet_id": traits.walletId,
          "wagering.transaction.kind": traits.kind,
        },
      },
      async (span) => {
        const result = await submit();
        span.setAttributes({
          ...transactionAttributes(result.transaction),
          "wagering.idempotent_replay": result.idempotentReplay,
          "wagering.duplicate_message": result.duplicateMessage,
        });
        return result;
      },
    );
  }

  /** Runs one reprocessing in its own trace: a job of the retry worker, not part of a request. */
  traceReprocess(
    transactionId: string,
    reprocess: () => Promise<ReprocessResult>,
  ): Promise<ReprocessResult> {
    return inSpan(
      "ReprocessPendingReference",
      { attributes: { "wagering.source": "retry", "wagering.transaction.id": transactionId } },
      async (span) => {
        const result = await reprocess();
        span.setAttributes(
          result.status === "skipped"
            ? { "wagering.reprocess.outcome": "skipped", "wagering.skip_reason": result.reason }
            : {
                "wagering.reprocess.outcome": result.status,
                ...transactionAttributes(result.transaction),
              },
        );
        return result;
      },
    );
  }

  submitted(
    source: TransactionSource,
    result: SubmitWagerTransactionResult,
    seconds: number,
  ): void {
    const { transaction } = result;
    let outcome: string;
    if (result.duplicateMessage) {
      this.metrics.duplicates.inc({ source, type: "duplicate_message" });
      outcome = "duplicate";
    } else if (result.idempotentReplay) {
      this.metrics.duplicates.inc({ source, type: "idempotent_replay" });
      outcome = "replay";
    } else {
      this.metrics.transactions.inc({ source, kind: transaction.kind, status: transaction.status });
      outcome = transaction.status.toLowerCase();
    }
    this.metrics.processingDuration.observe({ source, outcome }, seconds);
  }

  submissionFailed(source: TransactionSource, error: unknown, seconds: number): void {
    const conflict = conflictType(error);
    if (conflict !== undefined) {
      this.metrics.duplicates.inc({ source, type: conflict });
    }
    if (error instanceof WalletBusyError) {
      this.metrics.lockConflicts.inc({ source });
    }
    const outcome = conflict !== undefined ? "conflict" : "error";
    this.metrics.processingDuration.observe({ source, outcome }, seconds);
  }

  reprocessed(result: ReprocessResult, seconds: number): void {
    switch (result.status) {
      case "processed":
      case "rejected":
      case "failed":
        this.metrics.transactions.inc({
          source: "retry",
          kind: result.transaction.kind,
          status: result.transaction.status,
        });
        break;
      case "rescheduled":
        this.metrics.retries.inc({ operation: "reference_reprocess", reason: "reference_pending" });
        break;
      case "skipped":
        if (result.reason === "wallet-busy") {
          this.metrics.lockConflicts.inc({ source: "retry" });
        }
        break;
    }
    this.metrics.processingDuration.observe({ source: "retry", outcome: result.status }, seconds);
  }
}

function transactionAttributes(transaction: WagerTransactionView): Attributes {
  return {
    "wagering.transaction.id": transaction.id,
    "wagering.wallet_id": transaction.walletId,
    "wagering.transaction.kind": transaction.kind,
    "wagering.transaction.status": transaction.status,
    ...(transaction.failureCode === null
      ? {}
      : { "wagering.failure_code": transaction.failureCode }),
  };
}

function conflictType(error: unknown): string | undefined {
  if (error instanceof IdempotencyConflictError) {
    return "idempotency_conflict";
  }
  if (error instanceof ExternalTransactionConflictError) {
    return "external_transaction_conflict";
  }
  if (error instanceof InboxConflictError) {
    return "inbox_conflict";
  }
  return undefined;
}
