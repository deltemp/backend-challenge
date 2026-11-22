import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import type { Logger } from "pino";
import { isUuid } from "../../../application/request-limits";
import type { LedgerPage, ReconciliationReport } from "../../../application/use-cases/queries";
import type { WalletView } from "../../../application/views";
import { LOGGER } from "../../../infrastructure/observability/logger";
import { Metrics } from "../../../infrastructure/observability/metrics";
import {
  annotateContext,
  currentCorrelationId,
} from "../../../infrastructure/observability/request-context";
import type { UseCases } from "../../../infrastructure/use-cases";
import { USE_CASES } from "../../../infrastructure/use-cases.module";
import {
  type LedgerQuery,
  ledgerQuery,
  type OpenWalletBody,
  openWalletBody,
} from "../../contracts";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(USE_CASES) private readonly useCases: UseCases,
    private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** 201 with the wallet. An initial balance above zero is credited by an OPENING transaction. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async open(@Body({ schema: openWalletBody }) body: OpenWalletBody): Promise<WalletView> {
    const wallet = await this.useCases.openWallet.execute({
      ...body,
      correlationId: currentCorrelationId(),
    });
    annotateContext({ walletId: wallet.id });
    return wallet;
  }

  @Get(":walletId")
  find(@Param("walletId") walletId: string): Promise<WalletView> {
    annotateWallet(walletId);
    return this.useCases.getWallet.execute({ walletId });
  }

  /** Newest entry first; `nextCursor` leads to the older ones. */
  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query({ schema: ledgerQuery }) query: LedgerQuery,
  ): Promise<LedgerPage> {
    annotateWallet(walletId);
    return this.useCases.getWalletLedger.execute({
      walletId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /** A divergence is logged, counted and flagged in the answer. It is never corrected. */
  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
    annotateWallet(walletId);
    const report = await this.useCases.reconcileWallet.execute({ walletId });
    if (!report.consistent) {
      this.metrics.reconciliationDivergences.inc();
      this.logger.error(
        { version: report.version, checkedEntries: report.checkedEntries },
        "reconciliation found a stored balance different from its ledger",
      );
    }
    return report;
  }
}

/** Only a well-formed id goes into the logs: the path is caller input. */
function annotateWallet(walletId: string): void {
  if (isUuid(walletId)) {
    annotateContext({ walletId });
  }
}
