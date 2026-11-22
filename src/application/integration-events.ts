import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/events";
import type { EventContext, IntegrationEvent } from "../domain/events/integration-event";
import type { WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../domain/messaging/outbox-message";
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from "../domain/wagering/wager-transaction";
import type { Wallet } from "../domain/wallet/wallet";
import type { IdGenerator } from "./ports/id-generator";
import type { OutboxRepository } from "./ports/repositories";

/** A fresh context for each event of one unit of work: same time and correlation, new id. */
export function eventContexts(
  ids: IdGenerator,
  occurredAt: Date,
  correlationId: string,
  causationId?: string,
): () => EventContext {
  return () => ({ eventId: ids.next(), correlationId, causationId, occurredAt });
}

/**
 * The events of a decided transaction: `WagerTransactionProcessed`, followed by
 * `WalletBalanceChanged` when it moved the balance, or `WagerTransactionRejected`.
 */
export function decisionEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      const processed = WagerTransactionProcessed.from(transaction, context());
      return ledgerEntry === undefined
        ? [processed]
        : [processed, WalletBalanceChanged.from(wallet, ledgerEntry, context())];
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, context())];
    default:
      return [];
  }
}

/** Writes the events to the outbox, in order, inside the unit of work. */
export async function enqueueEvents(
  outbox: OutboxRepository,
  events: readonly IntegrationEvent<unknown>[],
): Promise<void> {
  for (const event of events) {
    await outbox.add(OutboxMessage.enqueue(event));
  }
}
