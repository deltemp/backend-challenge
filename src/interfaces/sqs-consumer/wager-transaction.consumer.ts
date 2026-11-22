import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { type Attributes, SpanKind, trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import { DependencyUnavailableError, WalletBusyError } from "../../application/errors";
import { FullJitterBackoff } from "../../domain/shared/backoff";
import type { AppConfig } from "../../infrastructure/config/config";
import { APP_CONFIG } from "../../infrastructure/config/config.module";
import { DependencyProbes } from "../../infrastructure/dependency-probes";
import { LOGGER } from "../../infrastructure/observability/logger";
import { Metrics } from "../../infrastructure/observability/metrics";
import {
  annotateContext,
  requestContext,
  resolveCorrelationId,
} from "../../infrastructure/observability/request-context";
import { contextFrom, inSpan, MESSAGING } from "../../infrastructure/observability/tracing";
import { mathRandom } from "../../infrastructure/runtime";
import { QueueUrls } from "../../infrastructure/sqs/queue-urls";
import { SQS_CLIENT } from "../../infrastructure/sqs/sqs-client";
import type { UseCases } from "../../infrastructure/use-cases";
import { USE_CASES } from "../../infrastructure/use-cases.module";
import { elapsedSeconds, sleep } from "../background";
import type { WagerTransactionRequested } from "../contracts";
import { WageringTelemetry } from "../telemetry";
import { type DeadLetterReason, parseMessage, permanentReason } from "./messages";

/** This consumer's half of the inbox key `(consumerName, messageId)`. */
export const CONSUMER_NAME = "wager-transactions";

// SQS allows ten attributes per message: a dead letter keeps nine originals and its reason.
const MAX_COPIED_ATTRIBUTES = 9;
// Every message of a FIFO queue has a group; this only satisfies the type.
const FALLBACK_GROUP = "dead-letters";
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

interface Queues {
  readonly inbound: string;
  readonly deadLetters: string;
}

/**
 * Done: the group goes on; the message was acknowledged, dead-lettered, or rescheduled after a
 * bug. Busy: its wallet is contended, so the rest of the group would meet the same lock; it is
 * handed back behind the rescheduled message. Outage: PostgreSQL or SQS is down.
 */
type Outcome = "done" | "busy" | "outage";

/**
 * Consumes `wager-transactions.fifo` with the same use case as the HTTP API.
 *
 * - A message is acknowledged only after its SQL transaction committed. A redelivery, after a
 *   crash in between, is answered from the inbox and does nothing again.
 * - A business rejection is a final result: acknowledged. A permanent error (malformed message,
 *   unknown type, unknown wallet, any conflict) goes straight to the dead-letter queue. A busy
 *   wallet, and a bug, reschedule the message with full-jitter backoff on its visibility timeout;
 *   the redrive policy moves it to the dead-letter queue once its receives run out.
 * - It checks PostgreSQL before each receive, and while PostgreSQL or SQS is unavailable it
 *   stops receiving and probes them with backoff, so an outage does not use up the receives of
 *   healthy messages. A message that met the outage keeps its visibility timeout.
 * - Messages of one group (a wallet) are processed in order, groups in parallel. After a busy
 *   wallet the rest of the group is handed back, and FIFO keeps it behind the rescheduled one;
 *   after a bug the group goes on, so the neighbours of a message bound for the dead-letter queue
 *   do not spend their receives along with it.
 * - On shutdown it aborts the long poll first, finishes the messages in flight and hands the
 *   others back at once.
 */
@Injectable()
export class WagerTransactionConsumer
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly stopping = new AbortController();
  private readonly retryBackoff: FullJitterBackoff;
  private readonly outageBackoff: FullJitterBackoff;
  private running: Promise<void> | undefined;
  private outages = 0;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly queueUrls: QueueUrls,
    @Inject(USE_CASES) private readonly useCases: UseCases,
    private readonly probes: DependencyProbes,
    private readonly telemetry: WageringTelemetry,
    private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.retryBackoff = FullJitterBackoff.create({ ...config.consumer.retry, random: mathRandom });
    this.outageBackoff = FullJitterBackoff.create({ ...config.outageBackoff, random: mathRandom });
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  // NestJS runs every module's onModuleDestroy before any beforeApplicationShutdown, and the
  // latter one module after another: aborting here stops every loop at once, the long poll first.
  onModuleDestroy(): void {
    this.stopping.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.running;
  }

  private async run(): Promise<void> {
    const signal = this.stopping.signal;
    this.logger.info({ queue: this.config.sqs.queues.wagerTransactions }, "sqs consumer started");
    while (!signal.aborted) {
      let queues: Queues;
      let messages: Message[];
      try {
        queues = await this.queues(signal);
        // Every receive counts against the redrive limit: an outage is found before one is spent.
        await this.probes.checkPostgres();
        messages = await this.receive(queues.inbound, signal);
      } catch (error) {
        if (signal.aborted) {
          break;
        }
        this.logger.warn(
          { err: error },
          "the consumer cannot receive: a dependency is unavailable",
        );
        await this.pauseUntilReachable(signal);
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await this.processBatch(queues, messages, signal);
      } catch (error) {
        // Every message settles its own failures; this is a bug in the loop itself. Pausing
        // keeps it from spinning, and the messages come back after their visibility timeout.
        this.metrics.unexpectedErrors.inc({ component: "sqs_consumer" });
        this.logger.error({ err: error }, "unexpected error in the consumer loop");
        outcome = "outage";
      }
      if (outcome === "outage") {
        await this.pauseUntilReachable(signal);
      } else {
        this.outages = 0;
      }
    }
    this.logger.info("sqs consumer stopped");
  }

  private async queues(signal: AbortSignal): Promise<Queues> {
    const names = this.config.sqs.queues;
    return {
      inbound: await this.queueUrls.resolve(names.wagerTransactions, signal),
      deadLetters: await this.queueUrls.resolve(names.wagerTransactionsDlq, signal),
    };
  }

  private async receive(queueUrl: string, signal: AbortSignal): Promise<Message[]> {
    const { consumer } = this.config;
    const { Messages } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: consumer.batchSize,
        WaitTimeSeconds: consumer.receiveWaitSeconds,
        VisibilityTimeout: consumer.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: signal },
    );
    return Messages ?? [];
  }

  private async processBatch(
    queues: Queues,
    messages: readonly Message[],
    signal: AbortSignal,
  ): Promise<Outcome> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? FALLBACK_GROUP;
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    let outage = false;
    const handBack: Message[] = [];
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const [index, message] of group.entries()) {
          if (signal.aborted) {
            // Shutdown: what was not started goes back to the queue at once.
            handBack.push(...group.slice(index));
            return;
          }
          if (outage) {
            // The rest stays invisible until its visibility timeout ends, then comes back.
            return;
          }
          const outcome = await this.handle(queues, message);
          if (outcome === "outage") {
            outage = true;
            return;
          }
          if (outcome === "busy") {
            // FIFO delivers none of the group while its head is invisible, so handing the rest
            // back keeps the group's order behind the rescheduled message.
            handBack.push(...group.slice(index + 1));
            return;
          }
        }
      }),
    );
    if (handBack.length > 0) {
      await this.handBack(queues.inbound, handBack);
    }
    return outage ? "outage" : "done";
  }

  /** One span per message, continuing the producer's trace when the message carries one. */
  private handle(queues: Queues, message: Message): Promise<Outcome> {
    const attributes = message.MessageAttributes;
    const parent = contextFrom({
      traceparent: attributes?.traceparent?.StringValue,
      tracestate: attributes?.tracestate?.StringValue,
    });
    return inSpan(
      `process ${this.config.sqs.queues.wagerTransactions}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [MESSAGING.system]: "aws_sqs",
          [MESSAGING.destination]: this.config.sqs.queues.wagerTransactions,
          [MESSAGING.operation]: "process",
          [MESSAGING.messageId]: message.MessageId ?? "",
          "wagering.receive_count": Number(message.Attributes?.ApproximateReceiveCount ?? "1"),
        },
      },
      () => this.handleInSpan(queues, message),
      parent,
    );
  }

  private async handleInSpan(queues: Queues, message: Message): Promise<Outcome> {
    const parsed = parseMessage(message.Body);
    if (!parsed.ok) {
      this.logger.warn({ reason: parsed.reason, errors: parsed.errors }, "message refused");
      return this.deadLetter(queues, message, parsed.reason);
    }
    const { messageId, data } = parsed.message;
    trace.getActiveSpan()?.setAttribute("wagering.message_id", messageId);
    const correlationId = resolveCorrelationId(
      message.MessageAttributes?.correlationId?.StringValue,
    );
    return requestContext.run(
      { correlationId, messageId, walletId: data.walletId, providerId: data.providerId },
      () => this.process(queues, message, parsed.message, correlationId),
    );
  }

  private async process(
    queues: Queues,
    message: Message,
    request: WagerTransactionRequested,
    correlationId: string,
  ): Promise<Outcome> {
    const startedAt = performance.now();
    try {
      const result = await this.telemetry.traceSubmission("sqs", request.data, () =>
        this.useCases.submitWagerTransaction.execute({
          ...request.data,
          correlationId,
          message: { consumerName: CONSUMER_NAME, messageId: request.messageId },
        }),
      );
      this.telemetry.submitted("sqs", result, elapsedSeconds(startedAt));
      annotateContext({ transactionId: result.transaction.id });
      this.logger.info(
        {
          status: result.transaction.status,
          failureCode: result.transaction.failureCode,
          idempotentReplay: result.idempotentReplay,
          duplicateMessage: result.duplicateMessage,
        },
        "wager transaction message processed",
      );
    } catch (error) {
      this.telemetry.submissionFailed("sqs", error, elapsedSeconds(startedAt));
      return this.settleFailure(queues, message, error);
    }
    if (this.config.consumer.ackDelayMs > 0) {
      // Test seam (NODE_ENV=test only): the window between commit and acknowledgement.
      await Bun.sleep(this.config.consumer.ackDelayMs);
    }
    markOutcome("acknowledged");
    await this.acknowledge(queues.inbound, message);
    return "done";
  }

  private async settleFailure(queues: Queues, message: Message, error: unknown): Promise<Outcome> {
    const reason = permanentReason(error);
    if (reason !== undefined) {
      this.logger.warn({ reason, err: error }, "message refused");
      return this.deadLetter(queues, message, reason);
    }
    if (error instanceof DependencyUnavailableError) {
      // It keeps the visibility timeout of its receive instead of the short backoff, so the
      // instances that have not noticed the outage yet do not receive it again meanwhile.
      this.metrics.retries.inc({ operation: "sqs_message", reason: "dependency_unavailable" });
      markOutcome("outage");
      this.logger.warn({ err: error }, "a dependency is unavailable: the message will be retried");
      return "outage";
    }
    if (error instanceof WalletBusyError) {
      this.logger.warn("the wallet is busy: the message will be retried");
      await this.retryLater(queues.inbound, message, "wallet_busy");
      return "busy";
    }
    // A bug. It is retried like a transient error, so a sporadic one resolves itself, and the
    // redrive policy moves the message to the dead-letter queue once its receives run out. The
    // rest of its group goes on: held back, it would spend its receives along with this one.
    this.metrics.unexpectedErrors.inc({ component: "sqs_consumer" });
    this.logger.error({ err: error }, "unexpected error while processing a message");
    await this.retryLater(queues.inbound, message, "unexpected");
    return "done";
  }

  /** Full-jitter backoff on the visibility timeout, from the receive count SQS keeps. */
  private async retryLater(queueUrl: string, message: Message, reason: string): Promise<void> {
    this.metrics.retries.inc({ operation: "sqs_message", reason });
    markOutcome("rescheduled", { "wagering.retry_reason": reason });
    const receives = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    const delayMs = this.retryBackoff.delayMs(Math.max(0, receives - 1));
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: Math.min(Math.ceil(delayMs / 1000), MAX_VISIBILITY_TIMEOUT_SECONDS),
        }),
      );
    } catch (error) {
      // The message comes back when its current visibility timeout ends instead.
      this.logger.warn({ err: error }, "could not reschedule a message");
    }
  }

  /**
   * SQS has no call that moves a message to the dead-letter queue: this sends a copy, with the
   * reason, and then deletes the original. A crash in between leaves a duplicate in the
   * dead-letter queue, never a lost message; the deduplication id absorbs it within five minutes.
   */
  private async deadLetter(
    queues: Queues,
    message: Message,
    reason: DeadLetterReason,
  ): Promise<Outcome> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.deadLetters,
          MessageBody: message.Body,
          MessageGroupId: message.Attributes?.MessageGroupId ?? FALLBACK_GROUP,
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: deadLetterAttributes(message, reason),
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, reason },
        "could not dead-letter a message: it will be retried",
      );
      await this.retryLater(queues.inbound, message, "dead_letter_failed");
      return "done";
    }
    this.metrics.deadLettered.inc({ reason });
    markOutcome("dead_lettered", { "wagering.dead_letter_reason": reason });
    await this.acknowledge(queues.inbound, message);
    return "done";
  }

  private async acknowledge(queueUrl: string, message: Message): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    } catch (error) {
      // It will be redelivered, and answered from the inbox.
      this.logger.warn({ err: error }, "could not acknowledge a message");
    }
  }

  /**
   * Makes received messages visible again at once: at shutdown, those not started yet, for
   * another instance; after a busy wallet, the rest of its group, which FIFO keeps behind the
   * rescheduled message.
   */
  private async handBack(queueUrl: string, messages: readonly Message[]): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          })),
        }),
      );
    } catch (error) {
      // They come back when their visibility timeout ends instead; FIFO still keeps the order.
      this.logger.warn({ err: error }, "could not hand received messages back");
    }
  }

  private async pauseUntilReachable(signal: AbortSignal): Promise<void> {
    this.metrics.consumerPaused.set(1);
    this.logger.warn("the consumer paused: PostgreSQL or SQS is unavailable");
    while (!signal.aborted) {
      await sleep(this.outageBackoff.delayMs(this.outages), signal);
      this.outages += 1;
      if (!signal.aborted && (await this.reachable())) {
        this.logger.info("the consumer resumed");
        break;
      }
    }
    this.metrics.consumerPaused.set(0);
  }

  private async reachable(): Promise<boolean> {
    try {
      await this.probes.checkPostgres();
      await this.probes.checkSqs();
      return true;
    } catch {
      return false;
    }
  }
}

/** How the message of the active process span was settled. */
function markOutcome(outcome: string, attributes: Attributes = {}): void {
  trace.getActiveSpan()?.setAttributes({ "wagering.message.outcome": outcome, ...attributes });
}

function deadLetterAttributes(
  message: Message,
  reason: DeadLetterReason,
): Record<string, MessageAttributeValue> {
  const attributes: Record<string, MessageAttributeValue> = {};
  for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
    if (Object.keys(attributes).length < MAX_COPIED_ATTRIBUTES && value.DataType !== undefined) {
      attributes[name] = {
        DataType: value.DataType,
        StringValue: value.StringValue,
        BinaryValue: value.BinaryValue,
      };
    }
  }
  attributes.deadLetterReason = { DataType: "String", StringValue: reason };
  return attributes;
}
