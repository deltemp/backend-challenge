import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Logger } from "pino";
import { TransientError } from "../../application/errors";
import type {
  PublishOutbox,
  PublishOutboxResult,
} from "../../application/use-cases/publish-outbox";
import { FullJitterBackoff } from "../../domain/shared/backoff";
import type { AppConfig } from "../../infrastructure/config/config";
import { APP_CONFIG } from "../../infrastructure/config/config.module";
import { LOGGER } from "../../infrastructure/observability/logger";
import { Metrics } from "../../infrastructure/observability/metrics";
import { mathRandom } from "../../infrastructure/runtime";
import { QueueUrls } from "../../infrastructure/sqs/queue-urls";
import { createSqsClient } from "../../infrastructure/sqs/sqs-client";
import { SqsEventPublisher } from "../../infrastructure/sqs/sqs-event-publisher";
import { createUseCases } from "../../infrastructure/use-cases";
import { sleep } from "../background";

/**
 * Publishes the outbox to `wager-events.fifo`, round after round, on every instance with the
 * `outbox` role: `PublishOutbox` claims rows with `FOR UPDATE SKIP LOCKED`, so publishers never
 * block each other, and a round interrupted by a crash rolls back for another one to redo.
 *
 * It has an SQS client of its own, with a short request timeout and a single attempt: the
 * outbox has its own backoff, and the round's SQL transaction stays open while it publishes.
 * Shutdown aborts the call in flight; its events are rescheduled, never lost.
 */
@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly stopping = new AbortController();
  private readonly client: SQSClient;
  private readonly backoff: FullJitterBackoff;
  private running: Promise<void> | undefined;

  constructor(
    private readonly orm: MikroORM,
    private readonly queueUrls: QueueUrls,
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.client = createSqsClient(config.aws, {
      requestTimeoutMs: config.outbox.publishTimeoutMs,
      maxAttempts: 1,
    });
    this.backoff = FullJitterBackoff.create({ ...config.outageBackoff, random: mathRandom });
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  // Every loop is aborted in onModuleDestroy, which NestJS runs for all modules first; each is
  // then awaited in beforeApplicationShutdown, which it runs one module after another.
  onModuleDestroy(): void {
    this.stopping.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.running;
    this.client.destroy();
  }

  private async run(): Promise<void> {
    const signal = this.stopping.signal;
    const { batchSize, pollIntervalMs } = this.config.outbox;
    this.logger.info({ queue: this.config.sqs.queues.wagerEvents }, "outbox publisher started");
    let publishOutbox: PublishOutbox | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        publishOutbox ??= await this.useCase(signal);
        const result = await publishOutbox.execute({ limit: batchSize });
        this.record(result);
        if (result.claimed > 0 && result.published === 0) {
          // Nothing got through: SQS is likely down. Each event already has its own backoff;
          // the loop backs off as a whole too, instead of rescheduling every due event at once.
          failures += 1;
          await sleep(this.backoff.delayMs(failures - 1), signal);
        } else {
          failures = 0;
          // A full batch means more may be due: go on at once.
          if (result.claimed < batchSize) {
            await sleep(pollIntervalMs, signal);
          }
        }
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        failures += 1;
        if (error instanceof TransientError) {
          this.logger.warn({ err: error }, "outbox round failed: a dependency is unavailable");
        } else {
          this.metrics.unexpectedErrors.inc({ component: "outbox_publisher" });
          this.logger.error({ err: error }, "unexpected error in an outbox round");
        }
        await sleep(this.backoff.delayMs(failures - 1), signal);
      }
    }
    this.logger.info("outbox publisher stopped");
  }

  private async useCase(signal: AbortSignal): Promise<PublishOutbox> {
    const queueUrl = await this.queueUrls.resolve(this.config.sqs.queues.wagerEvents, signal);
    const publisher = new SqsEventPublisher(this.client, queueUrl, signal);
    return createUseCases({ orm: this.orm, settings: this.config.wagering, publisher })
      .publishOutbox;
  }

  private record(result: PublishOutboxResult): void {
    this.metrics.outboxPublished.inc(result.published);
    for (const failure of result.failures) {
      this.metrics.retries.inc({ operation: "outbox_publish", reason: failure.reason });
    }
    if (result.failures.length > 0) {
      this.logger.warn(
        {
          claimed: result.claimed,
          published: result.published,
          rescheduled: result.failures.length,
          reasons: [...new Set(result.failures.map((failure) => failure.reason))],
        },
        "outbox events could not be published: rescheduled",
      );
    }
  }
}
