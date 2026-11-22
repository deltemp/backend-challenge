import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { Money } from "../../src/domain/money/money";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { ledgerDiscrepancies } from "../support/ledger";

// §13 integration: migrations and constraints. Every guarantee of the schema is proved against
// the real PostgreSQL with raw SQL that bypasses the application: the database must refuse a
// broken state on its own. Deferred checks run at COMMIT, so each case is its own transaction.

const PROVIDER = "provider-a";
const HASH = "a".repeat(64);

type Value = string | number | Date | null | { readonly [key: string]: unknown };
type Row = Record<string, Value>;

interface Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
}

/** A transaction written by `move`, with what a reference to it needs. */
interface Applied {
  readonly id: string;
  readonly external: string;
}

let database: TestDatabase | undefined;
let connection: SQL | undefined;

function db(): SQL {
  if (connection === undefined) {
    throw new Error("setup did not complete");
  }
  return connection;
}

const uuid = (): string => Bun.randomUUIDv7();

async function expectViolation(work: Promise<unknown>, errno: string, constraint: string) {
  const error: unknown = await work.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ errno, constraint });
}

function transactionRow(wallet: Wallet, overrides: Row = {}): Row {
  const id = uuid();
  const now = new Date();
  return {
    id,
    provider_id: PROVIDER,
    external_transaction_id: `txn-${id}`,
    idempotency_key: `${PROVIDER}:txn-${id}`,
    payload_hash: HASH,
    wallet_id: wallet.id,
    player_id: wallet.playerId,
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    currency: wallet.currency,
    reference_external_transaction_id: null,
    status: "PROCESSED",
    reference_transaction_id: null,
    failure_code: null,
    processed_at: now,
    observed_balance: "0.00",
    reference_deadline: null,
    next_attempt_at: null,
    reference_attempts: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** A parked REFUND, waiting for a BET that has not arrived. */
function parkedRow(wallet: Wallet, overrides: Row = {}): Row {
  const now = new Date();
  return transactionRow(wallet, {
    kind: "REFUND",
    reference_external_transaction_id: "bet-late",
    status: "PENDING_REFERENCE",
    processed_at: null,
    observed_balance: "100.00",
    reference_deadline: new Date(now.getTime() + 15 * 60_000),
    next_attempt_at: new Date(now.getTime() + 1000),
    ...overrides,
  });
}

function referencing(target: Applied): Row {
  return {
    reference_transaction_id: target.id,
    reference_external_transaction_id: target.external,
  };
}

async function insertTransaction(tx: SQL, row: Row): Promise<void> {
  await tx`insert into wager_transactions ${tx(row)}`;
}

async function insertEntry(tx: SQL, row: Row): Promise<void> {
  await tx`insert into ledger_entries ${tx(row)}`;
}

async function insertWallet(tx: SQL, row: Row): Promise<void> {
  await tx`insert into wallets ${tx(row)}`;
}

/** The FUNDING account of a currency, or a provider's settlement account, created on first use. */
async function account(
  tx: SQL,
  type: "FUNDING" | "PROVIDER_SETTLEMENT",
  currency: string,
  providerId: string | null,
): Promise<string> {
  const rows: { id: string }[] = await tx`
    select id from ledger_accounts
    where type = ${type} and currency = ${currency} and provider_id is not distinct from ${providerId}`;
  const existing = rows[0];
  if (existing !== undefined) {
    return existing.id;
  }
  const id = uuid();
  await tx`insert into ledger_accounts ${tx({
    id,
    type,
    currency,
    wallet_id: null,
    provider_id: providerId,
    created_at: new Date(),
  })}`;
  return id;
}

const settlement = (tx: SQL, currency = "BRL", providerId = PROVIDER) =>
  account(tx, "PROVIDER_SETTLEMENT", currency, providerId);
const funding = (tx: SQL, currency = "BRL") => account(tx, "FUNDING", currency, null);

/** A wallet with its account and, above zero, its OPENING credit: what the use case writes. */
async function openWallet(
  tx: SQL,
  options: { balance?: string; currency?: string; playerId?: string } = {},
): Promise<Wallet> {
  const currency = options.currency ?? "BRL";
  const balance = options.balance ?? "100.00";
  const wallet: Wallet = { id: uuid(), playerId: options.playerId ?? `player-${uuid()}`, currency };
  const now = new Date();
  await insertWallet(tx, {
    id: wallet.id,
    player_id: wallet.playerId,
    currency,
    balance,
    version: 1,
    created_at: now,
    updated_at: now,
  });
  await tx`insert into ledger_accounts ${tx({
    id: wallet.id,
    type: "PLAYER_WALLET",
    currency,
    wallet_id: wallet.id,
    provider_id: null,
    created_at: now,
  })}`;
  if (!Money.from({ amount: balance, currency }).isZero()) {
    const openingId = uuid();
    await insertTransaction(
      tx,
      transactionRow(wallet, {
        id: openingId,
        kind: "OPENING",
        amount: balance,
        observed_balance: balance,
        provider_id: null,
        external_transaction_id: null,
        idempotency_key: null,
        payload_hash: null,
        round_id: null,
        game_id: null,
      }),
    );
    await insertEntry(tx, {
      id: uuid(),
      transaction_id: openingId,
      wallet_id: wallet.id,
      wallet_version: 1,
      direction: "CREDIT",
      debit_account_id: await funding(tx, currency),
      credit_account_id: wallet.id,
      amount: balance,
      currency,
      balance_before: "0.00",
      balance_after: balance,
      created_at: now,
    });
  }
  return wallet;
}

async function currentState(tx: SQL, wallet: Wallet) {
  const rows: { balance: string; version: number }[] = await tx`
    select balance::text as balance, version from wallets where id = ${wallet.id} for update`;
  const state = rows[0];
  if (state === undefined) {
    throw new Error(`wallet ${wallet.id} does not exist`);
  }
  return state;
}

/**
 * An applied transaction that moves the balance, written consistently: the transaction, its
 * ledger entry against the provider's settlement account, and the wallet's new balance and
 * version. BET debits; ROLLBACK passes the direction mirroring its reference.
 */
async function move(
  tx: SQL,
  wallet: Wallet,
  movement: { kind: string; amount: string; direction?: "DEBIT" | "CREDIT" },
  overrides: Row = {},
): Promise<Applied> {
  const current = await currentState(tx, wallet);
  const direction = movement.direction ?? (movement.kind === "BET" ? "DEBIT" : "CREDIT");
  const before = Money.from({ amount: current.balance, currency: wallet.currency });
  const money = Money.from({ amount: movement.amount, currency: wallet.currency });
  const after = direction === "DEBIT" ? before.subtract(money) : before.add(money);
  const version = current.version + 1;
  const counter = await settlement(tx, wallet.currency);
  const row = transactionRow(wallet, {
    kind: movement.kind,
    amount: movement.amount,
    observed_balance: after.amount,
    ...overrides,
  });
  await insertTransaction(tx, row);
  await insertEntry(tx, {
    id: uuid(),
    transaction_id: String(row.id),
    wallet_id: wallet.id,
    wallet_version: version,
    direction,
    debit_account_id: direction === "DEBIT" ? wallet.id : counter,
    credit_account_id: direction === "DEBIT" ? counter : wallet.id,
    amount: movement.amount,
    currency: wallet.currency,
    balance_before: before.amount,
    balance_after: after.amount,
    created_at: new Date(),
  });
  await tx`update wallets set balance = ${after.amount}, version = ${version}, updated_at = now()
           where id = ${wallet.id}`;
  return { id: String(row.id), external: String(row.external_transaction_id) };
}

/** A ledger entry row of a BET of `amount` taking the wallet from `before` to `after`. */
async function betEntry(
  tx: SQL,
  wallet: Wallet,
  transactionId: string,
  values: { version: number; before: string; after: string; amount?: string },
): Promise<Row> {
  return {
    id: uuid(),
    transaction_id: transactionId,
    wallet_id: wallet.id,
    wallet_version: values.version,
    direction: "DEBIT",
    debit_account_id: wallet.id,
    credit_account_id: await settlement(tx, wallet.currency),
    amount: values.amount ?? "10.00",
    currency: wallet.currency,
    balance_before: values.before,
    balance_after: values.after,
    created_at: new Date(),
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  connection = new SQL(database.url);
});

afterAll(() =>
  cleanUp(
    () => connection?.close(),
    () => database?.drop(),
  ),
);

// The final invariant of every integration test: wallet.balance == balance rebuilt from the ledger.
afterEach(async () => {
  expect(await ledgerDiscrepancies(db())).toEqual([]);
});

describe("wallets", () => {
  test("at most one wallet per player and currency", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) => openWallet(tx, { playerId: wallet.playerId, balance: "0.00" })),
      "23505",
      "wallets_player_id_currency_unique",
    );
    await db().begin((tx) =>
      openWallet(tx, { playerId: wallet.playerId, currency: "USD", balance: "0.00" }),
    );
  });

  test("the balance is never negative", async () => {
    const wallet = await db().begin((tx) => openWallet(tx, { balance: "10.00" }));

    await expectViolation(
      db().begin((tx) => tx`update wallets set balance = -0.01 where id = ${wallet.id}`),
      "23514",
      "wallets_balance_check",
    );
    // A bet beyond the balance cannot be written either: its entry would end below zero.
    await expectViolation(
      db().begin((tx) =>
        move(tx, wallet, { kind: "BET", amount: "10.01" }, { observed_balance: "10.00" }),
      ),
      "23514",
      "ledger_entries_balances_check",
    );
  });

  test("the owner, currency and creation time of a wallet never change", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    for (const change of [
      () => db().begin((tx) => tx`update wallets set currency = 'USD' where id = ${wallet.id}`),
      () => db().begin((tx) => tx`update wallets set player_id = 'x' where id = ${wallet.id}`),
      () => db().begin((tx) => tx`update wallets set created_at = now() where id = ${wallet.id}`),
    ]) {
      await expectViolation(change(), "23000", "wallets_identity_immutable");
    }
  });

  test("wallets are never deleted", async () => {
    const wallet = await db().begin((tx) => openWallet(tx, { balance: "0.00" }));

    await expectViolation(
      db().begin((tx) => tx`delete from wallets where id = ${wallet.id}`),
      "23000",
      "wallets_never_deleted",
    );
  });

  test("every wallet has its own ledger account", async () => {
    await expectViolation(
      db().begin((tx) =>
        insertWallet(tx, {
          id: uuid(),
          player_id: `player-${uuid()}`,
          currency: "BRL",
          balance: "0.00",
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      ),
      "23514",
      "wallets_ledger_account",
    );
  });
});

describe("ledger entries", () => {
  test("are append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await db().begin((tx) => openWallet(tx));

    for (const change of [
      () => db().begin((tx) => tx`update ledger_entries set amount = amount + 1`),
      () => db().begin((tx) => tx`delete from ledger_entries`),
      () => db().begin((tx) => tx`truncate ledger_entries cascade`),
    ]) {
      await expectViolation(change(), "23000", "ledger_entries_append_only");
    }
  });

  test("their accounts never change: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await db().begin((tx) => openWallet(tx));
    const settlementId = await db().begin((tx) => settlement(tx));

    for (const change of [
      () =>
        db().begin(
          (tx) =>
            tx`update ledger_accounts set provider_id = 'provider-z' where id = ${settlementId}`,
        ),
      () => db().begin((tx) => tx`delete from ledger_accounts where id = ${settlementId}`),
      () => db().begin((tx) => tx`truncate ledger_accounts cascade`),
    ]) {
      await expectViolation(change(), "23000", "ledger_accounts_immutable");
    }
  });

  test("move a positive amount between two different accounts", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(async (tx) =>
        insertEntry(tx, {
          ...(await betEntry(tx, wallet, uuid(), {
            version: 2,
            before: "100.00",
            after: "100.00",
          })),
          amount: "0.00",
        }),
      ),
      "23514",
      "ledger_entries_amount_check",
    );
    await expectViolation(
      db().begin(async (tx) =>
        insertEntry(tx, {
          ...(await betEntry(tx, wallet, uuid(), { version: 2, before: "100.00", after: "90.00" })),
          credit_account_id: wallet.id,
        }),
      ),
      "23514",
      "ledger_entries_accounts_check",
    );
  });

  test("balance_after equals balance_before ± amount", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(async (tx) =>
        insertEntry(
          tx,
          await betEntry(tx, wallet, uuid(), { version: 2, before: "100.00", after: "95.00" }),
        ),
      ),
      "23514",
      "ledger_entries_balance_after_check",
    );
  });

  test("the wallet is the debited account of a DEBIT and the credited account of a CREDIT", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(async (tx) => {
        const entry = await betEntry(tx, wallet, uuid(), {
          version: 2,
          before: "100.00",
          after: "90.00",
        });
        await insertEntry(tx, {
          ...entry,
          debit_account_id: entry.credit_account_id ?? null,
          credit_account_id: wallet.id,
        });
      }),
      "23514",
      "ledger_entries_wallet_side_check",
    );
  });

  test("one ledger entry per transaction", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const bet = await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "10.00" }));

    await expectViolation(
      db().begin(async (tx) =>
        insertEntry(
          tx,
          await betEntry(tx, wallet, bet.id, { version: 3, before: "90.00", after: "80.00" }),
        ),
      ),
      "23505",
      "ledger_entries_transaction_id_unique",
    );
  });

  test("one ledger entry per wallet version", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "10.00" }));

    await expectViolation(
      db().begin(async (tx) =>
        insertEntry(
          tx,
          await betEntry(tx, wallet, uuid(), { version: 2, before: "100.00", after: "90.00" }),
        ),
      ),
      "23505",
      "ledger_entries_wallet_version_unique",
    );
  });

  test("an entry, its wallet and its accounts share one currency", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(async (tx) => {
        const bet = transactionRow(wallet, { observed_balance: "90.00" });
        await insertTransaction(tx, bet);
        await insertEntry(tx, {
          ...(await betEntry(tx, wallet, String(bet.id), {
            version: 2,
            before: "100.00",
            after: "90.00",
          })),
          currency: "USD",
        });
        await tx`update wallets set balance = 90.00, version = 2 where id = ${wallet.id}`;
      }),
      "23503",
      "ledger_entries_wallet_fkey",
    );
  });
});

describe("wager transactions", () => {
  test("idempotency keys are unique", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const loss = transactionRow(wallet, { kind: "LOSS" });
    await db().begin((tx) => insertTransaction(tx, loss));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, { kind: "LOSS", idempotency_key: loss.idempotency_key ?? null }),
        ),
      ),
      "23505",
      "wager_transactions_idempotency_key_unique",
    );
  });

  test("a provider's transaction id is unique, whatever the idempotency key", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const loss = transactionRow(wallet, { kind: "LOSS" });
    await db().begin((tx) => insertTransaction(tx, loss));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, {
            kind: "LOSS",
            external_transaction_id: loss.external_transaction_id ?? null,
          }),
        ),
      ),
      "23505",
      "wager_transactions_provider_external_id_unique",
    );
  });

  test("PENDING is never stored", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(tx, transactionRow(wallet, { status: "PENDING", processed_at: null })),
      ),
      "23514",
      "wager_transactions_status_check",
    );
  });

  test("amounts are positive, except that a LOSS may record zero", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) => insertTransaction(tx, transactionRow(wallet, { amount: "0.00" }))),
      "23514",
      "wager_transactions_amount_check",
    );
    await db().begin((tx) =>
      insertTransaction(
        tx,
        transactionRow(wallet, { kind: "LOSS", amount: "0.00", observed_balance: "100.00" }),
      ),
    );
  });

  test("only the internal OPENING lacks the provider fields, and it lacks all of them", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) => insertTransaction(tx, transactionRow(wallet, { provider_id: null }))),
      "23514",
      "wager_transactions_provider_fields_check",
    );
    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, {
            kind: "OPENING",
            external_transaction_id: null,
            idempotency_key: null,
            payload_hash: null,
            round_id: null,
            game_id: null,
          }),
        ),
      ),
      "23514",
      "wager_transactions_provider_fields_check",
    );
  });

  test("REFUND and ROLLBACK need a reference, and a BET never has one", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    const rejected = { status: "REJECTED", processed_at: null, failure_code: "AMOUNT_MISMATCH" };
    for (const row of [
      transactionRow(wallet, { ...rejected, kind: "REFUND" }),
      transactionRow(wallet, { ...rejected, kind: "ROLLBACK" }),
      transactionRow(wallet, { reference_external_transaction_id: "bet-0" }),
    ]) {
      await expectViolation(
        db().begin((tx) => insertTransaction(tx, row)),
        "23514",
        "wager_transactions_reference_kind_check",
      );
    }
  });

  test("an applied transaction records the internal id of its reference", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, { kind: "LOSS", reference_external_transaction_id: "bet-1" }),
        ),
      ),
      "23514",
      "wager_transactions_reference_resolution_check",
    );
  });

  test("failure codes are the documented ones, carried by REJECTED and FAILED only", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const rejected = { status: "REJECTED", processed_at: null };

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(tx, transactionRow(wallet, { ...rejected, failure_code: "NOPE" })),
      ),
      "23514",
      "wager_transactions_failure_code_check",
    );
    for (const row of [
      transactionRow(wallet, rejected),
      transactionRow(wallet, { ...rejected, failure_code: "INTERNAL_ERROR" }),
      transactionRow(wallet, { kind: "LOSS", failure_code: "INSUFFICIENT_FUNDS" }),
    ]) {
      await expectViolation(
        db().begin((tx) => insertTransaction(tx, row)),
        "23514",
        "wager_transactions_failure_check",
      );
    }
  });

  test("a wallet mismatch is rejected without disclosing the balance", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const mismatch = {
      status: "REJECTED",
      processed_at: null,
      failure_code: "WALLET_PLAYER_MISMATCH",
      player_id: "someone-else",
    };

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(tx, transactionRow(wallet, { ...mismatch, observed_balance: "100.00" })),
      ),
      "23514",
      "wager_transactions_observed_balance_presence_check",
    );
    await db().begin((tx) =>
      insertTransaction(tx, transactionRow(wallet, { ...mismatch, observed_balance: null })),
    );
  });

  test("a parked transaction has a deadline, and its next attempt comes no later", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const deadline = new Date(Date.now() + 60_000);

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          parkedRow(wallet, {
            reference_deadline: deadline,
            next_attempt_at: new Date(deadline.getTime() + 1),
          }),
        ),
      ),
      "23514",
      "wager_transactions_reference_wait_check",
    );
    await db().begin((tx) =>
      insertTransaction(
        tx,
        parkedRow(wallet, { reference_deadline: deadline, next_attempt_at: deadline }),
      ),
    );
  });

  test("FAILED is reached only from a stored PENDING_REFERENCE", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const parked = parkedRow(wallet);

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(tx, {
          ...parked,
          status: "FAILED",
          failure_code: "INTERNAL_ERROR",
          next_attempt_at: null,
        }),
      ),
      "23000",
      "wager_transactions_failed_only_from_pending_reference",
    );
    await db().begin((tx) => insertTransaction(tx, parked));
    await db().begin(
      (tx) => tx`update wager_transactions
                 set status = 'FAILED', failure_code = 'INTERNAL_ERROR', next_attempt_at = null
                 where id = ${parked.id ?? null}`,
    );
  });

  test("a decided transaction rejects further updates", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const processed = transactionRow(wallet, { kind: "LOSS", observed_balance: "100.00" });
    const rejected = transactionRow(wallet, {
      status: "REJECTED",
      processed_at: null,
      failure_code: "INSUFFICIENT_FUNDS",
    });
    const failed = parkedRow(wallet);
    await db().begin(async (tx) => {
      await insertTransaction(tx, processed);
      await insertTransaction(tx, rejected);
      await insertTransaction(tx, failed);
    });
    await db().begin(
      (tx) => tx`update wager_transactions
                 set status = 'FAILED', failure_code = 'INTERNAL_ERROR', next_attempt_at = null
                 where id = ${failed.id ?? null}`,
    );

    for (const row of [processed, rejected, failed]) {
      await expectViolation(
        db().begin(
          (tx) => tx`update wager_transactions set updated_at = now() where id = ${row.id ?? null}`,
        ),
        "23000",
        "wager_transactions_terminal_state",
      );
    }
  });

  test("a parked transaction changes only its outcome, and its attempts only go up", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const parked = parkedRow(wallet);
    const id = String(parked.id);
    await db().begin((tx) => insertTransaction(tx, parked));

    for (const change of [
      () => db().begin((tx) => tx`update wager_transactions set amount = 99 where id = ${id}`),
      () =>
        db().begin(
          (tx) => tx`update wager_transactions
                     set reference_deadline = reference_deadline + interval '1 hour'
                     where id = ${id}`,
        ),
    ]) {
      await expectViolation(change(), "23000", "wager_transactions_immutable_fields");
    }
    await db().begin(
      (tx) => tx`update wager_transactions
                 set reference_attempts = 2, next_attempt_at = next_attempt_at + interval '1 second'
                 where id = ${id}`,
    );
    await expectViolation(
      db().begin((tx) => tx`update wager_transactions set reference_attempts = 1 where id = ${id}`),
      "23000",
      "wager_transactions_reference_attempts_monotonic",
    );
    await db().begin(
      (tx) => tx`update wager_transactions
                 set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_attempt_at = null
                 where id = ${id}`,
    );
  });

  test("transactions are never deleted", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const loss = transactionRow(wallet, { kind: "LOSS" });
    await db().begin((tx) => insertTransaction(tx, loss));

    await expectViolation(
      db().begin((tx) => tx`delete from wager_transactions where id = ${loss.id ?? null}`),
      "23000",
      "wager_transactions_never_deleted",
    );
  });

  test("one OPENING per wallet", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, {
            kind: "OPENING",
            provider_id: null,
            external_transaction_id: null,
            idempotency_key: null,
            payload_hash: null,
            round_id: null,
            game_id: null,
          }),
        ),
      ),
      "23505",
      "wager_transactions_opening_unique",
    );
  });

  test("at most one applied reversal per transaction: REFUND and ROLLBACK exclude each other", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const bet = await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "25.00" }));
    await db().begin((tx) =>
      move(tx, wallet, { kind: "REFUND", amount: "25.00" }, referencing(bet)),
    );

    await expectViolation(
      db().begin((tx) => move(tx, wallet, { kind: "ROLLBACK", amount: "25.00" }, referencing(bet))),
      "23505",
      "wager_transactions_reversal_unique",
    );
  });
});

describe("inbox", () => {
  test("a message is recorded once per consumer", async () => {
    const message = {
      consumer_name: "wager-transactions",
      message_id: uuid(),
      payload_hash: HASH,
      received_at: new Date(),
      processed_at: new Date(),
    };
    await db()`insert into inbox_messages ${db()(message)}`;

    await expectViolation(
      db().begin((tx) => tx`insert into inbox_messages ${tx(message)}`),
      "23505",
      "inbox_messages_pkey",
    );
    await db()`insert into inbox_messages ${db()({ ...message, consumer_name: "another-consumer" })}`;
  });
});

describe("outbox", () => {
  function outboxRow(overrides: Row = {}): Row {
    const now = new Date();
    return {
      id: uuid(),
      aggregate_id: uuid(),
      ordering_key: uuid(),
      event_type: "WagerTransactionProcessed",
      payload: { eventId: "e" },
      occurred_at: now,
      attempts: 0,
      next_attempt_at: now,
      published_at: null,
      ...overrides,
    };
  }

  test("sequence numbers come from the database, in insert order", async () => {
    const first = outboxRow();
    const second = outboxRow({ ordering_key: first.ordering_key ?? null });
    await db().begin(async (tx) => {
      await tx`insert into outbox_messages ${tx(first)}`;
      await tx`insert into outbox_messages ${tx(second)}`;
    });

    const rows: { id: string; sequence: string }[] = await db()`
      select id, sequence_number::text as sequence from outbox_messages
      where id in (${first.id ?? null}, ${second.id ?? null}) order by sequence_number`;
    expect(rows.map((row) => row.id)).toEqual([String(first.id), String(second.id)]);

    const error: unknown = await db()`insert into outbox_messages ${db()({
      ...outboxRow(),
      sequence_number: 1,
    })}`.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ errno: "428C9" });
  });

  test("a pending message has its next attempt, and a published one has none", async () => {
    for (const row of [
      outboxRow({ next_attempt_at: null }),
      outboxRow({ published_at: new Date() }),
    ]) {
      await expectViolation(
        db().begin((tx) => tx`insert into outbox_messages ${tx(row)}`),
        "23514",
        "outbox_messages_schedule_check",
      );
    }
  });

  test("an unpublished event is never lost: it cannot be deleted or truncated", async () => {
    const pending = outboxRow();
    await db()`insert into outbox_messages ${db()(pending)}`;

    for (const change of [
      () => db().begin((tx) => tx`delete from outbox_messages where id = ${pending.id ?? null}`),
      () => db().begin((tx) => tx`truncate outbox_messages`),
    ]) {
      await expectViolation(change(), "23000", "outbox_messages_never_lost");
    }
  });

  test("only the publication schedule of a pending event changes, and attempts only go up", async () => {
    const pending = outboxRow();
    const id = String(pending.id);
    await db()`insert into outbox_messages ${db()(pending)}`;

    for (const change of [
      () =>
        db().begin(
          (tx) => tx`update outbox_messages set payload = '{"eventId":"other"}' where id = ${id}`,
        ),
      // A new sequence value would move the event behind later events of its wallet.
      () =>
        db().begin(
          (tx) => tx`update outbox_messages set sequence_number = default where id = ${id}`,
        ),
    ]) {
      await expectViolation(change(), "23000", "outbox_messages_event_immutable");
    }
    await db()`update outbox_messages
               set attempts = 2, next_attempt_at = next_attempt_at + interval '1 second'
               where id = ${id}`;
    await expectViolation(
      db().begin((tx) => tx`update outbox_messages set attempts = 1 where id = ${id}`),
      "23000",
      "outbox_messages_attempts_monotonic",
    );
  });

  test("the trace context belongs to the event: a JSON object or nothing, never changed", async () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    // Bun SQL binds a string for a jsonb column as a JSON string: not an object.
    await expectViolation(
      db().begin(
        (tx) => tx`insert into outbox_messages ${tx(outboxRow({ trace_context: traceparent }))}`,
      ),
      "23514",
      "outbox_messages_trace_context_check",
    );

    const traced = outboxRow({ trace_context: { traceparent } });
    const id = String(traced.id);
    await db()`insert into outbox_messages ${db()(traced)}`;
    const rows: { trace_context: unknown }[] = await db()`
      select trace_context from outbox_messages where id = ${id}`;
    expect(rows).toEqual([{ trace_context: { traceparent } }]);

    for (const change of [
      () =>
        db().begin((tx) => tx`update outbox_messages set trace_context = null where id = ${id}`),
      () =>
        db().begin(
          (tx) =>
            tx`update outbox_messages set trace_context = '{"traceparent":"other"}' where id = ${id}`,
        ),
    ]) {
      await expectViolation(change(), "23000", "outbox_messages_event_immutable");
    }
  });

  test("a published event is final, and only then may it be purged", async () => {
    const pending = outboxRow();
    const id = String(pending.id);
    await db()`insert into outbox_messages ${db()(pending)}`;
    await db()`update outbox_messages set published_at = now(), next_attempt_at = null
               where id = ${id}`;

    await expectViolation(
      db().begin((tx) => tx`update outbox_messages set published_at = now() where id = ${id}`),
      "23000",
      "outbox_messages_published_final",
    );
    await db()`delete from outbox_messages where id = ${id}`;
  });
});

// §6.2: every balance change has its ledger entry, and vice versa. Checked at commit.
describe("balance, ledger and transactions agree", () => {
  test("a valid history commits, and the balance equals the one rebuilt from the ledger", async () => {
    const wallet = await db().begin((tx) => openWallet(tx, { balance: "100.00" }));
    const openedAtZero = await db().begin((tx) => openWallet(tx, { balance: "0.00" }));

    await db().begin(async (tx) => {
      const bet = await move(tx, wallet, { kind: "BET", amount: "30.00" });
      const win = await move(tx, wallet, { kind: "WIN", amount: "45.50" }, referencing(bet));
      await insertTransaction(
        tx,
        transactionRow(wallet, {
          kind: "LOSS",
          amount: "0.00",
          observed_balance: "115.50",
          ...referencing(bet),
        }),
      );
      const stake = await move(tx, wallet, { kind: "BET", amount: "20.25" });
      await move(tx, wallet, { kind: "REFUND", amount: "20.25" }, referencing(stake));
      await move(
        tx,
        wallet,
        { kind: "ROLLBACK", amount: "45.50", direction: "DEBIT" },
        referencing(win),
      );
      await move(tx, openedAtZero, { kind: "WIN", amount: "5.00" });
    });

    const wallets: { id: string; balance: string; version: number }[] = await db()`
      select id, balance::text as balance, version from wallets
      where id in (${wallet.id}, ${openedAtZero.id}) order by version desc`;
    expect(wallets).toEqual([
      { id: wallet.id, balance: "70.00", version: 6 },
      { id: openedAtZero.id, balance: "5.00", version: 2 },
    ]);
    expect(await ledgerDiscrepancies(db())).toEqual([]);
  });

  test("a counter-account balance is derived from the entries, never stored", async () => {
    const wallet = await db().begin((tx) => openWallet(tx, { currency: "EUR", balance: "50.00" }));
    await db().begin(async (tx) => {
      const bet = await move(tx, wallet, { kind: "BET", amount: "20.00" });
      await move(tx, wallet, { kind: "WIN", amount: "5.00" }, referencing(bet));
    });

    const rows: { type: string; balance: string }[] = await db()`
      select a.type,
        coalesce(sum(case when e.credit_account_id = a.id then e.amount else -e.amount end), 0)::text as balance
      from ledger_accounts a
      join ledger_entries e on e.currency = a.currency
        and (e.credit_account_id = a.id or e.debit_account_id = a.id)
      where a.currency = 'EUR'
      group by a.type order by a.type`;
    expect(rows).toEqual([
      { type: "FUNDING", balance: "-50.00" },
      { type: "PLAYER_WALLET", balance: "35.00" },
      { type: "PROVIDER_SETTLEMENT", balance: "15.00" },
    ]);
  });

  test("a balance change without its ledger entry is refused", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(
        (tx) => tx`update wallets set balance = 90.00, version = 2 where id = ${wallet.id}`,
      ),
      "23514",
      "wallets_ledger_head",
    );
    await expectViolation(
      db().begin((tx) => tx`update wallets set balance = 90.00 where id = ${wallet.id}`),
      "23514",
      "wallets_ledger_head",
    );
  });

  test("a ledger entry without the wallet moving is refused", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin(async (tx) => {
        const bet = transactionRow(wallet, { observed_balance: "90.00" });
        await insertTransaction(tx, bet);
        await insertEntry(
          tx,
          await betEntry(tx, wallet, String(bet.id), {
            version: 2,
            before: "100.00",
            after: "90.00",
          }),
        );
      }),
      "23514",
      "ledger_entries_wallet_head",
    );
  });

  test("a late OPENING cannot slip into a wallet opened at zero without moving it", async () => {
    const wallet = await db().begin((tx) => openWallet(tx, { balance: "0.00" }));

    await expectViolation(
      db().begin(async (tx) => {
        const opening = transactionRow(wallet, {
          kind: "OPENING",
          amount: "50.00",
          observed_balance: "50.00",
          provider_id: null,
          external_transaction_id: null,
          idempotency_key: null,
          payload_hash: null,
          round_id: null,
          game_id: null,
        });
        await insertTransaction(tx, opening);
        await insertEntry(tx, {
          id: uuid(),
          transaction_id: String(opening.id),
          wallet_id: wallet.id,
          wallet_version: 1,
          direction: "CREDIT",
          debit_account_id: await funding(tx),
          credit_account_id: wallet.id,
          amount: "50.00",
          currency: "BRL",
          balance_before: "0.00",
          balance_after: "50.00",
          created_at: new Date(),
        });
      }),
      "23514",
      "ledger_entries_wallet_head",
    );
  });

  test("the stored snapshot of an applied transaction is the balance its entry ends at", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) =>
        move(tx, wallet, { kind: "BET", amount: "10.00" }, { observed_balance: "100.00" }),
      ),
      "23514",
      "ledger_entries_transaction_match",
    );
  });

  test("an applied transaction names its wallet's player and currency", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, {
            kind: "LOSS",
            player_id: "someone-else",
            observed_balance: "100.00",
          }),
        ),
      ),
      "23514",
      "wager_transactions_wallet_match",
    );
  });

  test("an applied transaction that moves the balance has its ledger entry", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    await expectViolation(
      db().begin((tx) => insertTransaction(tx, transactionRow(wallet, { kind: "WIN" }))),
      "23514",
      "wager_transactions_ledger_entry",
    );
  });

  test("a ledger entry records an applied transaction that moves the balance", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    const notMovingTheBalance: Row[] = [
      { kind: "LOSS" },
      { status: "REJECTED", processed_at: null, failure_code: "INSUFFICIENT_FUNDS" },
    ];
    for (const overrides of notMovingTheBalance) {
      await expectViolation(
        db().begin(async (tx) => {
          const transaction = transactionRow(wallet, overrides);
          await insertTransaction(tx, transaction);
          await insertEntry(
            tx,
            await betEntry(tx, wallet, String(transaction.id), {
              version: 2,
              before: "100.00",
              after: "90.00",
            }),
          );
          await tx`update wallets set balance = 90.00, version = 2 where id = ${wallet.id}`;
        }),
        "23514",
        "ledger_entries_transaction_match",
      );
    }
  });

  test("the direction follows the kind: a BET debits, a WIN credits, a ROLLBACK mirrors", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const bet = await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "10.00" }));

    for (const movement of [
      { kind: "BET", amount: "10.00", direction: "CREDIT" as const },
      { kind: "WIN", amount: "10.00", direction: "DEBIT" as const },
      { kind: "ROLLBACK", amount: "10.00", direction: "DEBIT" as const, ...referencing(bet) },
    ]) {
      const { kind, amount, direction, ...overrides } = movement;
      await expectViolation(
        db().begin((tx) => move(tx, wallet, { kind, amount, direction }, overrides)),
        "23514",
        "ledger_entries_transaction_match",
      );
    }
  });

  test("movements settle against the provider's own settlement account, in their currency", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));

    for (const counterAccount of [
      (tx: SQL) => funding(tx),
      (tx: SQL) => settlement(tx, "BRL", "provider-b"),
      (tx: SQL) => settlement(tx, "USD", PROVIDER),
    ]) {
      await expectViolation(
        db().begin(async (tx) => {
          const bet = transactionRow(wallet, { observed_balance: "90.00" });
          await insertTransaction(tx, bet);
          await insertEntry(tx, {
            ...(await betEntry(tx, wallet, String(bet.id), {
              version: 2,
              before: "100.00",
              after: "90.00",
            })),
            credit_account_id: await counterAccount(tx),
          });
          await tx`update wallets set balance = 90.00, version = 2 where id = ${wallet.id}`;
        }),
        "23514",
        "ledger_entries_transaction_match",
      );
    }
  });

  test("the entries of a wallet form an unbroken chain", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "30.00" }));

    await expectViolation(
      db().begin(async (tx) => {
        const bet = transactionRow(wallet, { amount: "30.00", observed_balance: "50.00" });
        await insertTransaction(tx, bet);
        await insertEntry(
          tx,
          await betEntry(tx, wallet, String(bet.id), {
            version: 3,
            before: "80.00",
            after: "50.00",
            amount: "30.00",
          }),
        );
        await tx`update wallets set balance = 50.00, version = 3 where id = ${wallet.id}`;
      }),
      "23514",
      "ledger_entries_chain",
    );
  });

  test("an applied transaction matches its reference: scope, kind and a reversal's amount", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const bet = await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "30.00" }));
    const otherRound = await db().begin((tx) =>
      move(tx, wallet, { kind: "BET", amount: "5.00" }, { round_id: "round-2" }),
    );
    const win = await db().begin((tx) =>
      move(tx, wallet, { kind: "WIN", amount: "1.00" }, referencing(bet)),
    );

    for (const [kind, amount, reference] of [
      ["REFUND", "20.00", bet],
      ["WIN", "20.00", otherRound],
      ["REFUND", "1.00", win],
    ] as const) {
      await expectViolation(
        db().begin((tx) => move(tx, wallet, { kind, amount }, referencing(reference))),
        "23514",
        "wager_transactions_reference_match",
      );
    }
  });

  test("no WIN or LOSS settles a bet that was reversed", async () => {
    const wallet = await db().begin((tx) => openWallet(tx));
    const bet = await db().begin((tx) => move(tx, wallet, { kind: "BET", amount: "30.00" }));
    await db().begin((tx) =>
      move(tx, wallet, { kind: "REFUND", amount: "30.00" }, referencing(bet)),
    );

    await expectViolation(
      db().begin((tx) =>
        insertTransaction(
          tx,
          transactionRow(wallet, { kind: "LOSS", observed_balance: "100.00", ...referencing(bet) }),
        ),
      ),
      "23514",
      "wager_transactions_reference_reversed",
    );
  });
});
