import type { SubmitWagerTransactionCommand } from "../../src/application/use-cases/submit-wager-transaction";
import type { WalletView } from "../../src/application/views";

export interface HttpAnswer {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON body; undefined when the body is empty. */
  readonly body: unknown;
}

export interface CallOptions {
  readonly method?: string;
  /** Sent as JSON, with its content type. */
  readonly json?: unknown;
  /** Sent as it is, for bodies that are not valid JSON. */
  readonly raw?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** One HTTP call to an instance; POST when there is a body, GET otherwise. */
export async function call(
  baseUrl: string,
  path: string,
  options: CallOptions = {},
): Promise<HttpAnswer> {
  const hasBody = options.json !== undefined || options.raw !== undefined;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (hasBody ? "POST" : "GET"),
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...options.headers },
    body: options.json !== undefined ? JSON.stringify(options.json) : options.raw,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** Opens a wallet over HTTP for a new player. */
export async function openWalletOverHttp(
  baseUrl: string,
  amount = "100.00",
  currency = "BRL",
): Promise<WalletView> {
  const answer = await call(baseUrl, "/wallets", {
    json: { playerId: `player-${Bun.randomUUIDv7()}`, initialBalance: { amount, currency } },
  });
  if (answer.status !== 201) {
    throw new Error(`the wallet was not opened: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  return answer.body as WalletView;
}

/** The HTTP body of a command: everything but the key, which travels in its header. */
export function httpBody(command: SubmitWagerTransactionCommand): Record<string, unknown> {
  const { idempotencyKey: _key, correlationId: _correlation, message: _message, ...body } = command;
  return body;
}

/** `POST /wagering/transactions` with the command's idempotency key. */
export function submitOverHttp(
  baseUrl: string,
  command: SubmitWagerTransactionCommand,
): Promise<HttpAnswer> {
  return call(baseUrl, "/wagering/transactions", {
    json: httpBody(command),
    headers: { "idempotency-key": command.idempotencyKey },
  });
}

/**
 * Submits like a well-behaved provider: a 503 is resent with the same key, as the contract
 * allows, until another answer comes or the attempts run out.
 */
export async function submitUntilSettled(
  baseUrl: string,
  command: SubmitWagerTransactionCommand,
  attempts = 20,
): Promise<HttpAnswer> {
  let answer = await submitOverHttp(baseUrl, command);
  for (let attempt = 1; answer.status === 503 && attempt < attempts; attempt += 1) {
    answer = await submitOverHttp(baseUrl, command);
  }
  return answer;
}
