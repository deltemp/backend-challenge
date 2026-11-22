import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import type { WageringSettings } from "../../src/application/policies";
import type { Clock } from "../../src/application/ports/clock";
import type { EventPublisher } from "../../src/application/ports/event-publisher";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import type { SubmitWagerTransactionCommand } from "../../src/application/use-cases/submit-wager-transaction";
import type { WalletView } from "../../src/application/views";
import type { DatabaseConfig } from "../../src/infrastructure/config/config";
import { createMikroOrmOptions } from "../../src/infrastructure/mikro-orm/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/mikro-orm/unit-of-work";
import { systemClock, uuidV7Ids } from "../../src/infrastructure/runtime";
import { createUseCases, type UseCases } from "../../src/infrastructure/use-cases";
import { cleanUp } from "./cleanup";
import { createTestDatabase, type TestDatabase, testDatabaseConfig } from "./databases";

export const TEST_SETTINGS: WageringSettings = {
  referenceTtlMs: 15 * 60_000,
  referenceRetry: { baseMs: 1000, capMs: 60_000 },
  outboxRetry: { baseMs: 1000, capMs: 60_000 },
};

/** For tests that never publish: reaching it is a bug in the test. */
export const NO_PUBLISHER: EventPublisher = {
  publish: () => Promise.reject(new Error("this test does not publish events")),
};

/** A clock the test moves by hand, so deadlines and backoff are exact. */
export class TestClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

export interface UseCaseHarness {
  readonly database: TestDatabase;
  /** Opened for the application: with the lock and statement timeouts. */
  readonly orm: MikroORM;
  /** A separate connection pool for assertions and for holding locks from outside. */
  readonly sql: SQL;
  readonly useCases: UseCases;
  /** The same use cases with another publisher, or over a wrapped unit of work (fault injection). */
  variant(options: UseCaseVariant): UseCases;
  close(): Promise<void>;
}

export interface UseCaseVariant {
  readonly publisher?: EventPublisher;
  readonly wrapUnitOfWork?: (unitOfWork: UnitOfWork) => UnitOfWork;
}

export interface HarnessOptions {
  readonly database?: Partial<Omit<DatabaseConfig, "url">>;
  readonly settings?: Partial<WageringSettings>;
  readonly publisher?: EventPublisher;
  readonly clock?: Clock;
  readonly random?: () => number;
}

/** A migrated database of its own, and the use cases wired to it with the real adapters. */
export async function openUseCaseHarness(options: HarnessOptions = {}): Promise<UseCaseHarness> {
  const database = await createTestDatabase();
  let orm: MikroORM | undefined;
  let sql: SQL | undefined;
  const close = () =>
    cleanUp(
      () => sql?.close(),
      () => orm?.close(),
      () => database.drop(),
    );
  try {
    const opened = await MikroORM.init(
      createMikroOrmOptions(
        testDatabaseConfig(database.url, { poolMax: 10, ...options.database }),
        "application",
      ),
    );
    orm = opened;
    sql = new SQL(database.url);
    const clock = options.clock ?? systemClock;
    const unitOfWork = new MikroOrmUnitOfWork(opened, uuidV7Ids, clock);
    const dependencies = {
      orm: opened,
      settings: { ...TEST_SETTINGS, ...options.settings },
      publisher: options.publisher ?? NO_PUBLISHER,
      clock,
      ids: uuidV7Ids,
      random: options.random,
      unitOfWork,
    };
    return {
      database,
      orm: opened,
      sql,
      useCases: createUseCases(dependencies),
      variant: (variant) =>
        createUseCases({
          ...dependencies,
          publisher: variant.publisher ?? dependencies.publisher,
          unitOfWork: variant.wrapUnitOfWork?.(unitOfWork) ?? unitOfWork,
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A promise and the function that settles it, to order two requests deterministically. */
export function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export async function openWallet(
  useCases: UseCases,
  amount = "100.00",
  currency = "BRL",
): Promise<WalletView> {
  return useCases.openWallet.execute({
    playerId: `player-${Bun.randomUUIDv7()}`,
    initialBalance: { amount, currency },
    correlationId: "test",
  });
}

/** A provider's transaction for the wallet, with consistent defaults; the key follows the id. */
export function transactionCommand(
  wallet: WalletView,
  overrides: Partial<SubmitWagerTransactionCommand> & { readonly kind: string },
): SubmitWagerTransactionCommand {
  const providerId = overrides.providerId ?? "provider-a";
  const externalTransactionId = overrides.externalTransactionId ?? `txn-${Bun.randomUUIDv7()}`;
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    money: { amount: "10.00", currency: wallet.balance.currency },
    correlationId: "test",
    ...overrides,
  };
}

export interface OutboxRow {
  readonly eventType: string;
  readonly orderingKey: string;
  readonly published: boolean;
  readonly attempts: number;
}

/** The outbox, in sequence order, optionally for one wallet. */
export async function outboxRows(sql: SQL, walletId?: string): Promise<OutboxRow[]> {
  const rows: OutboxRow[] = await sql`
    select event_type as "eventType", ordering_key as "orderingKey",
      published_at is not null as published, attempts
    from outbox_messages
    where ${walletId === undefined} or ordering_key = ${walletId ?? null}::uuid
    order by sequence_number`;
  return rows;
}

export async function balanceOf(sql: SQL, walletId: string): Promise<string> {
  const rows: { balance: string }[] =
    await sql`select balance::text as balance from wallets where id = ${walletId}`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`wallet ${walletId} does not exist`);
  }
  return row.balance;
}
