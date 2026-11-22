import { WagerTransactionPendingReference } from "../../domain/events/events";
import type { IntegrationEvent } from "../../domain/events/integration-event";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { Money, type MoneyProps } from "../../domain/money/money";
import { InvalidWagerTransactionError } from "../../domain/shared/errors";
import { payloadHash } from "../../domain/wagering/payload-hash";
import type { ReferenceRetryPolicy } from "../../domain/wagering/wager-rules";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import {
  type DuplicateKey,
  DuplicateKeyError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxConflictError,
  WalletNotFoundError,
} from "../errors";
import { decisionEvents, enqueueEvents, eventContexts } from "../integration-events";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { InboxRepository } from "../ports/repositories";
import type { UnitOfWork } from "../ports/unit-of-work";
import { RequestCheck } from "../request-limits";
import { type WagerTransactionView, wagerTransactionView } from "../views";
import { ledgerEntryOf, processWager } from "../wager-processing";

/** The queue message a transaction arrived in, recorded in the inbox with its effects. */
export interface QueueMessageRef {
  readonly consumerName: string;
  readonly messageId: string;
}

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly correlationId: string;
  /** Set when the transaction came from the queue. */
  readonly message?: QueueMessageRef | undefined;
}

export interface SubmitWagerTransactionResult {
  readonly transaction: WagerTransactionView;
  /** The idempotency key was seen with the same payload: the stored outcome is returned. */
  readonly idempotentReplay: boolean;
  /** The queue message was processed before (the inbox had it): nothing was done again. */
  readonly duplicateMessage: boolean;
}

/**
 * Unique keys the first run may lose to a concurrent copy on another wallet, and the reversal
 * index as a backstop no copy can win; the second run answers from the winner's row.
 */
const RACES: ReadonlySet<DuplicateKey> = new Set<DuplicateKey>([
  "idempotency-key",
  "external-transaction",
  "inbox-message",
  "reversal",
]);

const KINDS = Object.values(WagerTransactionKind);
const SUBMITTABLE = KINDS.filter((kind) => kind !== WagerTransactionKind.Opening);

interface ParsedRequest {
  readonly command: SubmitWagerTransactionCommand;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly payloadHash: string;
}

/**
 * Applies a provider's transaction, from HTTP or from the queue, in one SQL transaction: the
 * inbox row, the transaction, the balance, the ledger entry and the outbox events commit
 * together or not at all. The request is validated before any lock. Then the wallet's row lock
 * comes first, and the inbox and the idempotency key are looked up under it, so copies of one
 * request on the same wallet are serialized and all but the first become replays.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly referenceRetry: ReferenceRetryPolicy,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const request = parse(command);
    const receivedAt = this.clock.now();
    // A fresh transaction for each attempt; building the first one validates the request.
    const build = () =>
      WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: request.payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: request.kind,
        money: request.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: receivedAt,
      });
    const first = build();
    try {
      return await this.attempt(request, first);
    } catch (error) {
      if (!isRace(error)) {
        throw error;
      }
    }
    // A concurrent copy committed the same key first: run once more and answer from its row. The
    // lookups now find that row before any insert, so a violation on this run is no contention
    // but a bug: it propagates (500), with nothing committed.
    return this.attempt(request, build());
  }

  private attempt(
    request: ParsedRequest,
    transaction: WagerTransaction,
  ): Promise<SubmitWagerTransactionResult> {
    return this.unitOfWork.run(async (repositories) => {
      const { command } = request;
      const wallet = await repositories.wallets.lock(command.walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundError(command.walletId);
      }
      const message = command.message;
      const stored = await repositories.transactions.findByIdempotencyKey(command.idempotencyKey);

      if (message !== undefined) {
        const recorded = await repositories.inbox.find(message.consumerName, message.messageId);
        if (recorded !== undefined) {
          // A redelivery answers from what the message produced, and does nothing again.
          if (
            recorded.payloadHash !== request.payloadHash ||
            stored === undefined ||
            !stored.matchesPayload(request.payloadHash)
          ) {
            throw new InboxConflictError(message.messageId);
          }
          return {
            transaction: wagerTransactionView(stored),
            idempotentReplay: true,
            duplicateMessage: true,
          };
        }
      }

      const now = this.clock.now();
      if (stored !== undefined) {
        if (!stored.matchesPayload(request.payloadHash)) {
          throw new IdempotencyConflictError(stored.id);
        }
        if (message !== undefined) {
          await recordMessage(repositories.inbox, message, request.payloadHash, now);
        }
        return {
          transaction: wagerTransactionView(stored),
          idempotentReplay: true,
          duplicateMessage: false,
        };
      }
      const sameExternalId = await repositories.transactions.findByExternalId(
        command.providerId,
        command.externalTransactionId,
      );
      if (sameExternalId !== undefined) {
        throw new ExternalTransactionConflictError(sameExternalId.id);
      }

      const outcome = await processWager(repositories, {
        wallet,
        transaction,
        retryPolicy: this.referenceRetry,
        ids: this.ids,
        now,
      });
      await repositories.transactions.add(transaction);

      const context = eventContexts(this.ids, now, command.correlationId, message?.messageId);
      const events: IntegrationEvent<unknown>[] =
        transaction.status === WagerTransactionStatus.PendingReference
          ? [WagerTransactionPendingReference.from(transaction, context())]
          : decisionEvents(transaction, wallet, ledgerEntryOf(outcome), context);
      await enqueueEvents(repositories.outbox, events);
      if (message !== undefined) {
        await recordMessage(repositories.inbox, message, request.payloadHash, now);
      }
      return {
        transaction: wagerTransactionView(transaction),
        idempotentReplay: false,
        duplicateMessage: false,
      };
    });
  }
}

function isRace(error: unknown): error is DuplicateKeyError {
  return error instanceof DuplicateKeyError && RACES.has(error.key);
}

/**
 * Validates what the use cases refuse before any lock (AGENTS.md, "Validation comes before any
 * lock"), and computes the payload hash.
 */
function parse(command: SubmitWagerTransactionCommand): ParsedRequest {
  new RequestCheck()
    .identifier("providerId", command.providerId)
    .identifier("externalTransactionId", command.externalTransactionId)
    .identifier("idempotencyKey", command.idempotencyKey)
    .identifier("playerId", command.playerId)
    .identifier("roundId", command.roundId)
    .identifier("gameId", command.gameId)
    .identifier("referenceExternalTransactionId", command.referenceExternalTransactionId)
    .uuid("walletId", command.walletId)
    .identifier("consumerName", command.message?.consumerName)
    .identifier("messageId", command.message?.messageId)
    .verify();
  const kind = KINDS.find((value) => value === command.kind);
  if (kind === undefined) {
    // The value itself is not echoed: it is untrusted input, and error messages reach the logs.
    throw new InvalidWagerTransactionError(`kind must be one of ${SUBMITTABLE.join(", ")}`);
  }
  const money = Money.from(command.money);
  return {
    command,
    kind,
    money,
    payloadHash: payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    }),
  };
}

async function recordMessage(
  inbox: InboxRepository,
  message: QueueMessageRef,
  hash: string,
  now: Date,
): Promise<void> {
  const received = InboxMessage.receive({
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: hash,
    receivedAt: now,
  });
  received.markProcessed(now);
  await inbox.add(received);
}
