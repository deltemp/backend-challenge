import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { InvalidRequestError } from "../../../application/errors";
import { identifierIssue } from "../../../application/request-limits";
import type { SubmitWagerTransactionResult } from "../../../application/use-cases/submit-wager-transaction";
import type { WagerTransactionView } from "../../../application/views";
import type { MoneyProps } from "../../../domain/money/money";
import { InvariantViolationError } from "../../../domain/shared/errors";
import type { FailureCode } from "../../../domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction";
import { LOGGER } from "../../../infrastructure/observability/logger";
import {
  annotateContext,
  currentCorrelationId,
} from "../../../infrastructure/observability/request-context";
import type { UseCases } from "../../../infrastructure/use-cases";
import { USE_CASES } from "../../../infrastructure/use-cases.module";
import { elapsedSeconds } from "../../background";
import { type WagerTransactionBody, wagerTransactionBody } from "../../contracts";
import { WageringTelemetry } from "../../telemetry";
import { IdempotencyKeyRequiredError } from "../problem-details";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * A missing or blank `Idempotency-Key` is `IDEMPOTENCY_KEY_REQUIRED`. Guards run before the
 * parameter pipes, so this answer never depends on what else the request breaks.
 */
@Injectable()
export class RequireIdempotencyKey implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const key = context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined || key.trim() === "") {
      throw new IdempotencyKeyRequiredError();
    }
    return true;
  }
}

/** The answer to a submission (§9), with the failure code of a final outcome that failed. */
export interface SubmissionResponse {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | null;
  /** The balance observed when the outcome was decided, which every replay returns. */
  readonly balance: MoneyProps | null;
  readonly idempotentReplay: boolean;
}

/**
 * PROCESSED is 200 on the first call and on every replay, PENDING_REFERENCE 202. A final outcome
 * that is no success is 422: REJECTED by a business rule or FAILED, told apart by the body.
 */
export function submissionStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Pending:
      throw new InvariantViolationError("a submission never answers PENDING");
  }
}

@Controller()
export class WagerTransactionsController {
  constructor(
    @Inject(USE_CASES) private readonly useCases: UseCases,
    private readonly telemetry: WageringTelemetry,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Post("wagering/transactions")
  @UseGuards(RequireIdempotencyKey)
  async submit(
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string,
    @Body({ schema: wagerTransactionBody }) body: WagerTransactionBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmissionResponse> {
    const keyIssue = identifierIssue("idempotencyKey", idempotencyKey);
    if (keyIssue !== undefined) {
      throw new InvalidRequestError([{ path: "Idempotency-Key", message: keyIssue }]);
    }
    annotateContext({ walletId: body.walletId, providerId: body.providerId });
    const startedAt = performance.now();
    let result: SubmitWagerTransactionResult;
    try {
      result = await this.telemetry.traceSubmission("http", body, () =>
        this.useCases.submitWagerTransaction.execute({
          ...body,
          idempotencyKey,
          correlationId: currentCorrelationId(),
        }),
      );
    } catch (error) {
      this.telemetry.submissionFailed("http", error, elapsedSeconds(startedAt));
      throw error;
    }
    this.telemetry.submitted("http", result, elapsedSeconds(startedAt));
    const { transaction } = result;
    annotateContext({ transactionId: transaction.id });
    this.logger.info(
      {
        status: transaction.status,
        failureCode: transaction.failureCode,
        idempotentReplay: result.idempotentReplay,
      },
      "wager transaction submitted",
    );
    response.status(submissionStatus(transaction.status));
    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: transaction.balance,
      idempotentReplay: result.idempotentReplay,
    };
  }

  /** 200 with the transaction, whatever its status: the lookup itself succeeded. */
  @Get("wagering/transactions/:transactionId")
  findById(@Param("transactionId") transactionId: string): Promise<WagerTransactionView> {
    return this.useCases.getWagerTransaction.byId({ transactionId });
  }

  /** 200 with the transaction, whatever its status. */
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  findByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.useCases.getWagerTransaction.byExternalId({ providerId, externalTransactionId });
  }
}
