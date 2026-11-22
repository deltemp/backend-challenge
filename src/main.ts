import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { StandardSchemaValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Logger } from "pino";
import { AppModule } from "./app.module";
import { type AppConfig, ConfigError, loadConfig } from "./infrastructure/config/config";
import { createLogger } from "./infrastructure/observability/logger";
import { PinoNestLogger } from "./infrastructure/observability/nest-logger";
import { RequestContextMiddleware } from "./infrastructure/observability/request-context.middleware";

/**
 * One entry point for every role. Every process serves the management endpoints (health and
 * metrics) over HTTP, whatever its roles, so orchestrators and tests can probe worker-only
 * processes too. APP_ROLES selects the rest: `api` mounts the wagering API; `consumer`, `outbox`
 * and `retry` start the SQS consumer and the background workers.
 */
async function bootstrap(config: AppConfig, logger: Logger): Promise<void> {
  const app = await NestFactory.create(AppModule.forRoot(config, logger), {
    logger: new PinoNestLogger(logger),
  });

  // Registered on the HTTP server directly, before listen() lets NestJS add its body parser:
  // a request rejected by the parser (malformed JSON) still gets a correlation id, an access log
  // line and a duration sample. A module-level middleware would run after the parser.
  const requestContext = app.get(RequestContextMiddleware);
  app.use(requestContext.use.bind(requestContext));

  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();
  await app.listen(config.port);
  const { port } = app.getHttpServer().address() as AddressInfo;
  logger.info({ port, roles: config.roles }, "http server listening");

  // NestJS closes the application on SIGTERM and SIGINT. This watchdog bounds that shutdown, so
  // a stuck dependency cannot keep the process alive past the orchestrator's grace period.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "shutdown requested");
      setTimeout(() => {
        logger.fatal({ timeoutMs: config.shutdownTimeoutMs }, "shutdown timed out, forcing exit");
        process.exit(1);
      }, config.shutdownTimeoutMs).unref();
    });
  }
}

let config: AppConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger(config.logLevel);

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  process.exit(1);
});

try {
  await bootstrap(config, logger);
} catch (error) {
  logger.fatal({ err: error }, "bootstrap failed");
  process.exit(1);
}
