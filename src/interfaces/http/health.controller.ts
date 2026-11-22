import { Controller, Get } from "@nestjs/common";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";
import { PostgresHealthIndicator } from "../../infrastructure/mikro-orm/postgres.health";
import { SqsHealthIndicator } from "../../infrastructure/sqs/sqs.health";
import { Public } from "./auth/auth.guard";

@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  /** The process is up and serving HTTP. Checks no dependency. */
  @Get("live")
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** PostgreSQL answers queries and SQS resolves the inbound queue. */
  @Get("ready")
  @HealthCheck()
  ready() {
    return this.health.check([() => this.postgres.check(), () => this.sqs.check()]);
  }
}
