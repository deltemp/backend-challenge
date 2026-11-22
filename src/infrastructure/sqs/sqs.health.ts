import { Inject, Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";
import type { Logger } from "pino";
import { DependencyProbes } from "../dependency-probes";
import { LOGGER } from "../observability/logger";

@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly probes: DependencyProbes,
    private readonly indicators: HealthIndicatorService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async check() {
    const indicator = this.indicators.check("sqs");
    try {
      await this.probes.checkSqs();
      return indicator.up();
    } catch (error) {
      // Details go to the logs only: the health endpoint is public.
      this.logger.warn({ err: error }, "sqs readiness check failed");
      return indicator.down({ message: "unreachable or inbound queue missing" });
    }
  }
}
