import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { Logger } from "pino";
import { LOGGER } from "./logger";

/** Marks the end of a graceful shutdown, after every other provider has released its resources. */
@Injectable()
export class ShutdownLogger implements OnApplicationShutdown {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  onApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, "application shut down");
  }
}
