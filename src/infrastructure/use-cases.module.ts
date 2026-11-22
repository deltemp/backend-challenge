import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Module } from "@nestjs/common";
import type { EventPublisher } from "../application/ports/event-publisher";
import type { AppConfig } from "./config/config";
import { APP_CONFIG } from "./config/config.module";
import { createUseCases } from "./use-cases";

/** Injection token for the {@link UseCases} of the API, the consumer and the retry worker. */
export const USE_CASES = Symbol("USE_CASES");

// Only the outbox worker talks to the broker, through a publisher and an SQS client of its own;
// everything else writes events to the outbox, inside its SQL transaction.
const OUTBOX_ONLY: EventPublisher = {
  publish: () => Promise.reject(new Error("only the outbox worker publishes events")),
};

@Global()
@Module({
  providers: [
    {
      provide: USE_CASES,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        createUseCases({ orm, settings: config.wagering, publisher: OUTBOX_ONLY }),
    },
  ],
  exports: [USE_CASES],
})
export class UseCasesModule {}
