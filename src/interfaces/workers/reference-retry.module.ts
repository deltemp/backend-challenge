import { Module } from "@nestjs/common";
import { WageringTelemetry } from "../telemetry";
import { ReferenceRetryWorker } from "./reference-retry.worker";

/** The reference retry worker, started only by processes with the `retry` role. */
@Module({ providers: [ReferenceRetryWorker, WageringTelemetry] })
export class ReferenceRetryModule {}
