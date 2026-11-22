import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Logger } from "pino";
import { LOGGER } from "./logger";
import { Metrics } from "./metrics";
import { RequestContextMiddleware } from "./request-context.middleware";
import { ShutdownLogger } from "./shutdown-logger";
import type { Tracing } from "./tracing";

const TRACING = Symbol("TRACING");

/** Exports the spans still buffered once everything else has stopped. */
@Injectable()
class TracingLifecycle implements OnApplicationShutdown {
  constructor(@Inject(TRACING) private readonly tracing: Tracing) {}

  onApplicationShutdown(): Promise<void> {
    return this.tracing.shutdown();
  }
}

@Global()
@Module({})
export class ObservabilityModule {
  /**
   * The logger and the tracer provider are created before NestJS boots, so bootstrap failures
   * are logged as JSON too, and every span of the application has a provider.
   */
  static forRoot(logger: Logger, tracing: Tracing): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: LOGGER, useValue: logger },
        { provide: TRACING, useValue: tracing },
        Metrics,
        RequestContextMiddleware,
        ShutdownLogger,
        TracingLifecycle,
      ],
      exports: [LOGGER, Metrics, RequestContextMiddleware],
    };
  }
}
