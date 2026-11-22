import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "./config/config";
import { APP_CONFIG } from "./config/config.module";
import { SQS_CLIENT } from "./sqs/sqs-client";
import { withTimeout } from "./timeout";

/**
 * Cheap, bounded checks that PostgreSQL and SQS answer: readiness uses them, and so does the
 * consumer, to know when to resume after an outage. Each throws when its dependency fails.
 */
@Injectable()
export class DependencyProbes {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs a real query: MikroORM connects lazily, so its connection flags prove nothing. */
  async checkPostgres(): Promise<void> {
    await withTimeout(
      this.orm.em.fork().getConnection().execute("select 1"),
      this.config.healthCheckTimeoutMs,
    );
  }

  /** Resolving the inbound queue proves both that SQS answers and that the queue exists. */
  async checkSqs(): Promise<void> {
    await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.queues.wagerTransactions }),
      { abortSignal: AbortSignal.timeout(this.config.healthCheckTimeoutMs) },
    );
  }
}
