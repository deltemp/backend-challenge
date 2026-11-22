import { type DynamicModule, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { AppConfig } from "./infrastructure/config/config";
import { ConfigModule } from "./infrastructure/config/config.module";
import { DependencyProbesModule } from "./infrastructure/dependency-probes.module";
import { DatabaseModule } from "./infrastructure/mikro-orm/database.module";
import { ObservabilityModule } from "./infrastructure/observability/observability.module";
import { SqsModule } from "./infrastructure/sqs/sqs.module";
import { UseCasesModule } from "./infrastructure/use-cases.module";
import { HttpModule } from "./interfaces/http/http.module";
import { WageringApiModule } from "./interfaces/http/wagering/wagering-api.module";
import { SqsConsumerModule } from "./interfaces/sqs-consumer/sqs-consumer.module";
import { OutboxPublisherModule } from "./interfaces/workers/outbox-publisher.module";
import { ReferenceRetryModule } from "./interfaces/workers/reference-retry.module";

/**
 * Root module. HttpModule holds the management endpoints (health and metrics) that every process
 * serves. The module of each role (the wagering API, the SQS consumer, the outbox publisher and
 * the reference retry worker) is imported only when `config.roles` includes it.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    const roles = new Set(config.roles);
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        DatabaseModule,
        SqsModule,
        DependencyProbesModule,
        UseCasesModule,
        HttpModule,
        ...(roles.has("api") ? [WageringApiModule] : []),
        ...(roles.has("consumer") ? [SqsConsumerModule] : []),
        ...(roles.has("outbox") ? [OutboxPublisherModule] : []),
        ...(roles.has("retry") ? [ReferenceRetryModule] : []),
      ],
    };
  }
}
