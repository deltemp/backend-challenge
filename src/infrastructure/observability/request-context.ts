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

/** The correlation id of the request or message being handled; a new one outside any context. */
export function currentCorrelationId(): string {
  return requestContext.getStore()?.correlationId ?? Bun.randomUUIDv7();
}

/** Adds identifiers to the current context, so every later log line of it carries them. */
export function annotateContext(
  identifiers: Pick<RequestContext, "messageId" | "transactionId" | "walletId" | "providerId">,
): void {
  const store = requestContext.getStore();
  if (store !== undefined) {
    Object.assign(store, identifiers);
  }
}

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
