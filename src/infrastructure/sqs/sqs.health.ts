import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";
import type { Logger } from "pino";
import type { AppConfig } from "../config/config";
import { APP_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger";
import { SQS_CLIENT } from "./sqs-client";

@Injectable()
export class SqsHealthIndicator {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    private readonly indicators: HealthIndicatorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Resolving the inbound queue proves both that SQS answers and that the queue exists. */
  async check() {
    const indicator = this.indicators.check("sqs");
    try {
      await this.client.send(
        new GetQueueUrlCommand({ QueueName: this.config.sqs.queues.wagerTransactions }),
        { abortSignal: AbortSignal.timeout(this.config.healthCheckTimeoutMs) },
      );
      return indicator.up();
    } catch (error) {
      // Details go to the logs only: the health endpoint is public.
      this.logger.warn({ err: error }, "sqs readiness check failed");
      return indicator.down({ message: "unreachable or inbound queue missing" });
    }
  }
}
