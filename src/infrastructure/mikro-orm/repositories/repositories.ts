import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { Clock } from "../../../application/ports/clock";
import type { IdGenerator } from "../../../application/ports/id-generator";
import type {
  InboxRepository,
  LedgerAccountRepository,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../../application/ports/repositories";
import { LedgerAccount, LedgerAccountType } from "../../../domain/ledger/ledger-account";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { InvariantViolationError } from "../../../domain/shared/errors";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";
import type { Wallet } from "../../../domain/wallet/wallet";
import { activeTraceContext } from "../../observability/tracing";
import {
  InboxMessageRecord,
  LedgerAccountRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "../records";
import {
  accountRow,
  inboxMessageFromRow,
  inboxMessageRow,
  ledgerEntryFromRow,
  ledgerEntryRow,
  money,
  outboxMessageFromRow,
  outboxMessageRow,
  outboxMessageSchedule,
  signedMoney,
  wagerTransactionFromRow,
  wagerTransactionOutcome,
  wagerTransactionRow,
  walletFromRow,
  walletRow,
} from "./mappers";

// Every read bypasses the identity map: a unit of work reads a row again after taking a lock
// precisely to see its latest committed state. Every write is a native statement, run at once,
// so the order of the statements is the order of the calls and a unique violation surfaces
// where it happens. The deferred schema checks run at the commit.

const FRESH = { disableIdentityMap: true } as const;

// Get-or-create of the shared counter-accounts: each conflict target is its partial unique index.
const SETTLEMENT_INSERT = `
  insert into ledger_accounts (id, type, currency, wallet_id, provider_id, created_at)
  values (?, ?, ?, ?, ?, ?)
  on conflict (provider_id, currency) where type = 'PROVIDER_SETTLEMENT' do nothing`;
const FUNDING_INSERT = `
  insert into ledger_accounts (id, type, currency, wallet_id, provider_id, created_at)
  values (?, ?, ?, ?, ?, ?)
  on conflict (currency) where type = 'FUNDING' do nothing`;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lock(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row === null ? undefined : walletFromRow(row);
  }

  async lockIfFree(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return row === null ? undefined : walletFromRow(row);
  }

  async find(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { id }, FRESH);
    return row === null ? undefined : walletFromRow(row);
  }

  async findIdByOwner(playerId: string, currency: string): Promise<string | undefined> {
    const row = await this.em.findOne(
      WalletRecord,
      { playerId, currency },
      { ...FRESH, fields: ["id"] },
    );
    return row?.id;
  }

  async add(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletRow(wallet));
  }

  async save(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
  }
}

class MikroOrmLedgerAccountRepository implements LedgerAccountRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async add(account: LedgerAccount): Promise<void> {
    await this.em.insert(LedgerAccountRecord, accountRow(account));
  }

  settlementAccount(providerId: string, currency: string): Promise<string> {
    return this.getOrCreate(
      () => this.findId({ type: LedgerAccountType.ProviderSettlement, providerId, currency }),
      (id) =>
        this.insertIfAbsent(
          SETTLEMENT_INSERT,
          LedgerAccount.providerSettlement({
            id,
            providerId,
            currency,
            createdAt: this.clock.now(),
          }),
        ),
    );
  }

  fundingAccount(currency: string): Promise<string> {
    return this.getOrCreate(
      () => this.findId({ type: LedgerAccountType.Funding, currency }),
      (id) =>
        this.insertIfAbsent(
          FUNDING_INSERT,
          LedgerAccount.funding({ id, currency, createdAt: this.clock.now() }),
        ),
    );
  }

  /** Inserts the account unless the partial unique index already has one: no update, no lock. */
  private async insertIfAbsent(statement: string, account: LedgerAccount): Promise<void> {
    const row = accountRow(account);
    await this.em.execute(
      statement,
      [row.id, row.type, row.currency, row.walletId, row.providerId, row.createdAt],
      "run",
    );
  }

  private async findId(where: {
    readonly type: string;
    readonly currency: string;
    readonly providerId?: string;
  }): Promise<string | undefined> {
    const row = await this.em.findOne(LedgerAccountRecord, where, { ...FRESH, fields: ["id"] });
    return row?.id;
  }

  /**
   * Reads first, the common case. Otherwise inserts without ever updating or locking an
   * existing row (a concurrent creator only makes the insert wait for its commit) and reads
   * again.
   */
  private async getOrCreate(
    find: () => Promise<string | undefined>,
    create: (id: string) => Promise<unknown>,
  ): Promise<string> {
    const existing = await find();
    if (existing !== undefined) {
      return existing;
    }
    await create(this.ids.next());
    const created = await find();
    if (created === undefined) {
      throw new InvariantViolationError("a ledger account was neither found nor created");
    }
    return created;
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async find(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return row === null ? undefined : wagerTransactionFromRow(row);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, FRESH);
    return row === null ? undefined : wagerTransactionFromRow(row);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      FRESH,
    );
    return row === null ? undefined : wagerTransactionFromRow(row);
  }

  async isReversed(id: string): Promise<boolean> {
    const reversals = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: id,
      status: "PROCESSED",
      kind: { $in: ["REFUND", "ROLLBACK"] },
    });
    return reversals > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: "PENDING_REFERENCE", nextAttemptAt: { $lte: now } },
      { ...FRESH, fields: ["id"], orderBy: { createdAt: "asc", id: "asc" }, limit },
    );
    return rows.map((row) => row.id);
  }

  async add(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, wagerTransactionRow(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      wagerTransactionOutcome(transaction),
    );
  }
}

interface SummaryRow {
  readonly id: string;
  readonly currency: string;
  readonly version: number;
  readonly stored: string;
  readonly calculated: string;
  readonly entries: number;
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async add(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerEntryRow(entry));
  }

  async page(
    walletId: string,
    options: { readonly beforeVersion: number | undefined; readonly limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      options.beforeVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: options.beforeVersion } },
      { ...FRESH, orderBy: { walletVersion: "desc" }, limit: options.limit },
    );
    return rows.map(ledgerEntryFromRow);
  }

  /** One statement, so the stored and the rebuilt balance come from the same snapshot. */
  async summarize(walletId: string): Promise<LedgerSummary | undefined> {
    const rows = await this.em.execute<SummaryRow[]>(
      `select w.id, w.currency, w.version, w.balance::text as stored,
         coalesce(sum(case when e.credit_account_id = w.id then e.amount
                           when e.debit_account_id = w.id then -e.amount
                           else 0 end), 0)::numeric(20,2)::text as calculated,
         count(e.id)::int as entries
       from wallets w
       left join ledger_entries e on e.wallet_id = w.id
       where w.id = ?
       group by w.id`,
      [walletId],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      walletId: row.id,
      version: row.version,
      storedBalance: money(row.stored, row.currency),
      calculatedBalance: signedMoney(row.calculated, row.currency),
      entries: row.entries,
    };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, FRESH);
    return row === null ? undefined : inboxMessageFromRow(row);
  }

  async add(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, inboxMessageRow(message));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /** Records the trace context active when the event is written, for the publisher to pass on. */
  async add(message: OutboxMessage): Promise<void> {
    const row = outboxMessageRow(message);
    const active = activeTraceContext();
    await this.em.insert(OutboxMessageRecord, {
      ...row,
      traceContext: row.traceContext ?? (Object.keys(active).length > 0 ? active : null),
    });
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // The head of each wallet's queue: no unpublished event of the same wallet comes before it.
    // A head held by another publisher is skipped, and the events behind it are excluded too,
    // so no two publishers ever hold events of the same wallet.
    const claimed = await this.em.execute<{ id: string }[]>(
      `select o.id
       from outbox_messages o
       where o.published_at is null
         and o.next_attempt_at <= ?
         and not exists (
           select 1 from outbox_messages earlier
           where earlier.ordering_key = o.ordering_key
             and earlier.published_at is null
             and earlier.sequence_number < o.sequence_number)
       order by o.sequence_number
       limit ?
       for update of o skip locked`,
      [now, limit],
    );
    if (claimed.length === 0) {
      return [];
    }
    const rows = await this.em.find(
      OutboxMessageRecord,
      { id: { $in: claimed.map((row) => row.id) } },
      { ...FRESH, orderBy: { sequenceNumber: "asc" } },
    );
    return rows.map(outboxMessageFromRow);
  }

  /**
   * Only an unpublished row changes: a published one is final. Updating no row means another
   * round already published it, which is fine, and keeps the rest of this round's markings.
   */
  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      outboxMessageSchedule(message),
    );
  }
}

/** Repositories bound to one transaction's EntityManager. */
export function createRepositories(
  em: EntityManager,
  ids: IdGenerator,
  clock: Clock,
): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    accounts: new MikroOrmLedgerAccountRepository(em, ids, clock),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
