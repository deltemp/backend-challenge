import { Money } from "../../../src/domain/money/money";
import { FullJitterBackoff } from "../../../src/domain/shared/backoff";
import { FailureCode } from "../../../src/domain/wagering/failure-code";
import { payloadHash } from "../../../src/domain/wagering/payload-hash";
import {
  applyWagerTransaction,
  type ReferenceRetryPolicy,
  type WagerOutcome,
} from "../../../src/domain/wagering/wager-rules";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";

export const T0 = new Date("2026-07-29T15:00:00.000Z");
export const MINUTE = 60_000;

export const PROVIDER = "provider-a";
export const PLAYER = "player-1";
export const WALLET = "wallet-1";
export const ROUND = "round-987";
export const SETTLEMENT_ACCOUNT = "settlement:provider-a:BRL";
export const FUNDING_ACCOUNT = "funding:BRL";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

export function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

let sequence = 0;
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

/** A random source fixed at the middle of [0, 1), so backoff delays are predictable. */
export const MIDDLE = () => 0.5;

export const RETRY_POLICY: ReferenceRetryPolicy = {
  ttlMs: 15 * MINUTE,
  backoff: FullJitterBackoff.create({ baseMs: 1000, capMs: 60_000, random: MIDDLE }),
};

export function openWallet(
  balance: string,
  options: { id?: string; playerId?: string; currency?: string } = {},
): Wallet {
  const initialBalance = Money.from({ amount: balance, currency: options.currency ?? "BRL" });
  const { wallet } = Wallet.open({
    id: options.id ?? WALLET,
    playerId: options.playerId ?? PLAYER,
    initialBalance,
    openedAt: T0,
    opening: initialBalance.isZero()
      ? undefined
      : {
          transactionId: nextId("opening"),
          entryId: nextId("entry"),
          fundingAccountId: FUNDING_ACCOUNT,
        },
  });
  return wallet;
}

export type TransactionOverrides = Partial<Omit<CreateWagerTransactionProps, "payloadHash">> & {
  readonly kind: WagerTransactionKind;
};

/** A PENDING transaction submitted by the provider, with consistent defaults. */
export function submit(overrides: TransactionOverrides): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("txn");
  const fields = {
    providerId: overrides.providerId ?? PROVIDER,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER,
    walletId: overrides.walletId ?? WALLET,
    roundId: overrides.roundId ?? ROUND,
    gameId: overrides.gameId ?? "fortune-chimp",
    kind: overrides.kind,
    money: overrides.money ?? brl("25.00"),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    ...fields,
    id: overrides.id ?? nextId("id"),
    idempotencyKey: overrides.idempotencyKey ?? `${fields.providerId}:${externalTransactionId}`,
    payloadHash: payloadHash(fields),
    createdAt: overrides.createdAt ?? T0,
  });
}

/** A transaction already persisted in the given state, as a repository would rebuild it. */
export function persisted(
  overrides: TransactionOverrides & {
    readonly status: WagerTransactionStatus;
    readonly failureCode?: FailureCode;
  },
): WagerTransaction {
  const submitted = submit(overrides);
  return WagerTransaction.rehydrate({
    id: submitted.id,
    providerId: submitted.providerId,
    externalTransactionId: submitted.externalTransactionId,
    idempotencyKey: submitted.idempotencyKey,
    payloadHash: submitted.payloadHash,
    walletId: submitted.walletId,
    playerId: submitted.playerId,
    roundId: submitted.roundId,
    gameId: submitted.gameId,
    kind: submitted.kind,
    money: submitted.money,
    referenceExternalTransactionId: submitted.referenceExternalTransactionId,
    createdAt: submitted.createdAt,
    status: overrides.status,
    referenceTransactionId: undefined,
    failureCode:
      overrides.failureCode ??
      (overrides.status === WagerTransactionStatus.Rejected
        ? FailureCode.InsufficientFunds
        : overrides.status === WagerTransactionStatus.Failed
          ? FailureCode.InternalError
          : undefined),
    processedAt: overrides.status === WagerTransactionStatus.Processed ? T0 : undefined,
    observedBalance: undefined,
    referenceDeadline:
      overrides.status === WagerTransactionStatus.PendingReference ? at(15) : undefined,
    nextAttemptAt: overrides.status === WagerTransactionStatus.PendingReference ? at(1) : undefined,
    referenceAttempts: 0,
    updatedAt: T0,
  });
}

/** A PROCESSED BET of the default player, wallet and round. */
export function processedBet(amount = "25.00", overrides: Partial<TransactionOverrides> = {}) {
  return persisted({
    ...overrides,
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    status: WagerTransactionStatus.Processed,
  });
}

export function apply(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: { readonly transaction: WagerTransaction; readonly reversed?: boolean },
  now: Date = T0,
): WagerOutcome {
  return applyWagerTransaction({
    wallet,
    transaction,
    reference:
      reference === undefined
        ? undefined
        : { transaction: reference.transaction, reversed: reference.reversed ?? false },
    settlementAccountId: SETTLEMENT_ACCOUNT,
    ledgerEntryId: nextId("entry"),
    retryPolicy: RETRY_POLICY,
    now,
  });
}
