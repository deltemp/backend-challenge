import { Module } from "@nestjs/common";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";

/** The outbox publisher, started only by processes with the `outbox` role. */
@Module({ providers: [OutboxPublisherWorker] })
export class OutboxPublisherModule {}
