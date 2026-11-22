import { Module } from "@nestjs/common";
import { WageringTelemetry } from "../../telemetry";
import {
  RequireIdempotencyKey,
  WagerTransactionsController,
} from "./wager-transactions.controller";
import { WalletsController } from "./wallets.controller";

/** The wagering API of §9, mounted only by processes with the `api` role. */
@Module({
  controllers: [WalletsController, WagerTransactionsController],
  providers: [WageringTelemetry, RequireIdempotencyKey],
})
export class WageringApiModule {}
