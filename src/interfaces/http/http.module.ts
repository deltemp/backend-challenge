import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TerminusModule } from "@nestjs/terminus";
import { PostgresHealthIndicator } from "../../infrastructure/mikro-orm/postgres.health";
import { SqsHealthIndicator } from "../../infrastructure/sqs/sqs.health";
import { AuthGuard } from "./auth/auth.guard";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";

@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: "json" })],
  controllers: [HealthController, MetricsController],
  providers: [
    PostgresHealthIndicator,
    SqsHealthIndicator,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class HttpModule {}
