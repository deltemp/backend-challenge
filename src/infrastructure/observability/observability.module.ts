import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Logger } from "pino";
import { LOGGER } from "./logger";
import { Metrics } from "./metrics";
import { RequestContextMiddleware } from "./request-context.middleware";
import { ShutdownLogger } from "./shutdown-logger";

@Global()
@Module({})
export class ObservabilityModule {
  /** The logger is created before NestJS boots, so bootstrap failures are logged as JSON too. */
  static forRoot(logger: Logger): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: LOGGER, useValue: logger },
        Metrics,
        RequestContextMiddleware,
        ShutdownLogger,
      ],
      exports: [LOGGER, Metrics, RequestContextMiddleware],
    };
  }
}
