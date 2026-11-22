import { Module } from "@nestjs/common";
import { WageringTelemetry } from "../telemetry";
import { WagerTransactionConsumer } from "./wager-transaction.consumer";

/** The consumer of `wager-transactions.fifo`, started only by processes with the `consumer` role. */
@Module({ providers: [WagerTransactionConsumer, WageringTelemetry] })
export class SqsConsumerModule {}
