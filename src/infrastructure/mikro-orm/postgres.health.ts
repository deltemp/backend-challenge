import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger";
import { withTimeout } from "../timeout";

@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly orm: MikroORM,
    private readonly indicators: HealthIndicatorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Runs a real query: MikroORM connects lazily, so its connection flags prove nothing. */
  async check() {
    const indicator = this.indicators.check("postgres");
    try {
      await withTimeout(
        this.orm.em.fork().getConnection().execute("select 1"),
        this.config.healthCheckTimeoutMs,
      );
      return indicator.up();
    } catch (error) {
      // Details go to the logs only: the health endpoint is public.
      this.logger.warn({ err: error }, "postgres readiness check failed");
      return indicator.down({ message: "unreachable" });
    }
  }
}
