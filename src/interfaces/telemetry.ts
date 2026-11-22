import { Injectable } from "@nestjs/common";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  WalletBusyError,
} from "../application/errors";
import type { ReprocessResult } from "../application/use-cases/reprocess-pending-reference";
import type { SubmitWagerTransactionResult } from "../application/use-cases/submit-wager-transaction";
import { Metrics, type TransactionSource } from "../infrastructure/observability/metrics";

/**
 * Records the business metrics from what the use cases report. The use cases stay free of
 * metrics; the interfaces that call them know the entry point and translate their results.
 */
@Injectable()
export class WageringTelemetry {
  constructor(private readonly metrics: Metrics) {}

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
