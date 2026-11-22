import { type DynamicModule, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { AppConfig } from "./infrastructure/config/config";
import { ConfigModule } from "./infrastructure/config/config.module";
import { DatabaseModule } from "./infrastructure/mikro-orm/database.module";
import { ObservabilityModule } from "./infrastructure/observability/observability.module";
import { SqsModule } from "./infrastructure/sqs/sqs.module";
import { HttpModule } from "./interfaces/http/http.module";

/**
 * Root module. HttpModule holds the management endpoints (health and metrics) that every
 * process serves. The modules of each role (the wagering API, the SQS consumer, the outbox
 * publisher and the reference retry worker) will be imported here only when `config.roles`
 * includes them.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        ObservabilityModule.forRoot(logger),
        DatabaseModule,
        SqsModule,
        HttpModule,
      ],
    };
  }
}
