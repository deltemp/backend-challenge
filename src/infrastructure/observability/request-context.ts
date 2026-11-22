import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identifiers attached to every log line written while a request or message is handled.
 * Only identifiers belong here: never amounts, balances or payloads.
 */
export interface RequestContext {
  readonly correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const CORRELATION_ID_HEADER = "x-correlation-id";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Returns the caller's correlation id when it is safe to log, otherwise a new UUIDv7.
 * Rejecting arbitrary header content keeps untrusted input out of the logs.
 */
export function resolveCorrelationId(candidate: string | undefined): string {
  return candidate !== undefined && CORRELATION_ID_PATTERN.test(candidate)
    ? candidate
    : Bun.randomUUIDv7();
}
