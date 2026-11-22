import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { TerminusModule } from "@nestjs/terminus";
import { PostgresHealthIndicator } from "../../infrastructure/mikro-orm/postgres.health";
import { SharedStateMetrics } from "../../infrastructure/observability/shared-state.metrics";
import { SqsHealthIndicator } from "../../infrastructure/sqs/sqs.health";
import { AuthGuard } from "./auth/auth.guard";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { ProblemDetailsFilter } from "./problem-details.filter";

/**
 * What every process serves over HTTP, whatever its roles: health, metrics (with the gauges of
 * shared state), the authentication extension point and the problem-details error mapping.
 */
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: "json" })],
  controllers: [HealthController, MetricsController],
  providers: [
    PostgresHealthIndicator,
    SqsHealthIndicator,
    SharedStateMetrics,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class HttpModule {}
