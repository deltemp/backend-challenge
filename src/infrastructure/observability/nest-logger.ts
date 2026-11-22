import type { LoggerService } from "@nestjs/common";
import type { Logger } from "pino";

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Routes NestJS framework logs through pino, so every line on stdout is JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  // NestJS passes the context as the last string argument, and error() passes a stack trace
  // before it: error(message, stack, context).
  private write(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const context = typeof rest.at(-1) === "string" ? (rest.pop() as string) : undefined;
    const stack = level === "error" && typeof rest[0] === "string" ? rest[0] : undefined;

    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
    } else if (typeof message === "object" && message !== null) {
      this.logger[level]({ context, ...message });
    } else {
      this.logger[level]({ context, stack }, String(message));
    }
  }
}
