import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DependencyUnavailableError } from "../../src/application/errors";
import type { Repositories } from "../../src/application/ports/repositories";
import type { UnitOfWork } from "../../src/application/ports/unit-of-work";
import type { WalletView } from "../../src/application/views";
import { WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";
import { ledgerDiscrepancies } from "../support/ledger";
import {
  balanceOf,
  openUseCaseHarness,
  openWallet,
  outboxRows,
  TestClock,
  transactionCommand,
  type UseCaseHarness,
} from "../support/use-cases";

// §7.1 and §13: a ROLLBACK or REFUND delivered before its reference, reprocessed by the worker.
describe("FindDuePendingReferences and ReprocessPendingReference", () => {
  const clock = new TestClock();
  let harness: UseCaseHarness | undefined;

  function setup(): UseCaseHarness {
    if (harness === undefined) {
      throw new Error("setup did not complete");
    }
    return harness;
  }

  beforeAll(async () => {
    // A fixed random value makes every backoff delay exact: half of its ceiling.
    harness = await openUseCaseHarness({ clock, random: () => 0.5 });
  });

  afterAll(() => harness?.close());

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  async function park(wallet: WalletView, kind: string, reference: string, externalId?: string) {
    const result = await setup().useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, {
        kind,
        money: { amount: "25.00", currency: "BRL" },
        referenceExternalTransactionId: reference,
        ...(externalId === undefined ? {} : { externalTransactionId: externalId }),
      }),
    );
    expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);
    return result.transaction;
  }

  function bet(wallet: WalletView, externalTransactionId: string) {
    return setup().useCases.submitWagerTransaction.execute(
      transactionCommand(wallet, {
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
        externalTransactionId,
      }),
    );
  }

  function reprocess(transactionId: string) {
    return setup().useCases.reprocessPendingReference.execute({
      transactionId,
      correlationId: "retry-worker",
    });
  }

  async function storedTransaction(id: string) {
    const rows: {
      status: string;
      failureCode: string | null;
      attempts: number;
      next: Date | null;
    }[] = await setup().sql`
        select status, failure_code as "failureCode", reference_attempts as attempts,
          next_attempt_at as next
        from wager_transactions where id = ${id}`;
    return rows[0];
  }

  test("a parked REFUND is applied once its BET has arrived", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", `bet-${wallet.id}`);
    await bet(wallet, `bet-${wallet.id}`);
    clock.advance(1000);

    const result = await reprocess(refund.id);

    expect(result).toMatchObject({
      status: "processed",
      transaction: { status: "PROCESSED", balance: { amount: "100.00", currency: "BRL" } },
    });
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
    expect((await outboxRows(sql, wallet.id)).map((row) => row.eventType)).toEqual([
      // the OPENING
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      // the REFUND parked
      "WagerTransactionPendingReference",
      // the BET
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      // the REFUND applied
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("while the reference is missing, each attempt reschedules, without an event", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", "bet-never");
    const eventsBefore = await outboxRows(sql, wallet.id);
    clock.advance(1000);

    const result = await reprocess(refund.id);

    expect(result.status).toBe("rescheduled");
    const stored = await storedTransaction(refund.id);
    expect(stored).toMatchObject({ status: "PENDING_REFERENCE", attempts: 1 });
    // Retry 1 of base 1 s: half of 2 s.
    expect(stored?.next?.getTime()).toBe(clock.now().getTime() + 1000);
    expect(await outboxRows(sql, wallet.id)).toEqual(eventsBefore);
  });

  test("a lookup at the deadline that still finds nothing rejects it with REFERENCE_NOT_FOUND", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", "bet-never");
    clock.advance(15 * 60_000);

    const result = await reprocess(refund.id);

    expect(result).toMatchObject({
      status: "rejected",
      transaction: { status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND" },
    });
    expect((await outboxRows(sql, wallet.id)).at(-1)?.eventType).toBe("WagerTransactionRejected");
  });

  test("a transaction not yet due, or whose wallet is busy, is skipped", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", "bet-never");

    expect(await reprocess(refund.id)).toEqual({ status: "skipped", reason: "not-due" });

    clock.advance(1000);
    const busy = await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      return reprocess(refund.id);
    });
    expect(busy).toEqual({ status: "skipped", reason: "wallet-busy" });
    expect((await storedTransaction(refund.id))?.attempts).toBe(0);
  });

  test("due transactions come oldest first, so a pending chain resolves in order", async () => {
    const { sql, useCases } = setup();
    const wallet = await openWallet(useCases, "100.00");
    const betId = `bet-${wallet.id}`;
    const refundId = `refund-${wallet.id}`;
    const refund = await park(wallet, "REFUND", betId, refundId);
    clock.advance(10);
    // A ROLLBACK of the REFUND: its reference exists but is itself still pending.
    const rollback = await park(wallet, "ROLLBACK", refundId);
    await bet(wallet, betId);
    clock.advance(2000);

    const due = await useCases.findDuePendingReferences.execute({ limit: 100 });
    const order = due.filter((id) => id === refund.id || id === rollback.id);
    expect(order).toEqual([refund.id, rollback.id]);

    expect((await reprocess(refund.id)).status).toBe("processed");
    expect((await reprocess(rollback.id)).status).toBe("processed");
    // 100 - 25 (bet) + 25 (refund) - 25 (rollback of the refund).
    expect(await balanceOf(sql, wallet.id)).toBe("75.00");
  });

  test("an unrecoverable error marks the parked transaction FAILED, with its event", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", `bet-${wallet.id}`);
    await bet(wallet, `bet-${wallet.id}`);
    clock.advance(1000);
    const faulty = setup().variant({ wrapUnitOfWork: (inner) => failingOnce(inner) });

    const result = await faulty.reprocessPendingReference.execute({
      transactionId: refund.id,
      correlationId: "retry-worker",
    });

    expect(result).toMatchObject({ status: "failed", transaction: { status: "FAILED" } });
    expect(await storedTransaction(refund.id)).toMatchObject({
      status: "FAILED",
      failureCode: "INTERNAL_ERROR",
    });
    expect((await outboxRows(sql, wallet.id)).at(-1)?.eventType).toBe("WagerTransactionFailed");
    expect(await balanceOf(sql, wallet.id)).toBe("75.00");
  });

  test("a transient error leaves the transaction parked and unchanged, for a later attempt", async () => {
    const { sql } = setup();
    const wallet = await openWallet(setup().useCases, "100.00");
    const refund = await park(wallet, "REFUND", `bet-${wallet.id}`);
    await bet(wallet, `bet-${wallet.id}`);
    clock.advance(1000);
    // The first attempt loses the database while writing; the next one is real.
    const flaky = setup().variant({
      wrapUnitOfWork: (inner) => failingOnce(inner, () => new DependencyUnavailableError()),
    });

    await expect(
      flaky.reprocessPendingReference.execute({ transactionId: refund.id, correlationId: "r" }),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);

    expect(await storedTransaction(refund.id)).toMatchObject({
      status: "PENDING_REFERENCE",
      attempts: 0,
    });
    expect((await outboxRows(sql, wallet.id)).map((row) => row.eventType)).not.toContain(
      "WagerTransactionFailed",
    );
    expect(await balanceOf(sql, wallet.id)).toBe("75.00");
    expect((await reprocess(refund.id)).status).toBe("processed");
  });
});

/** The first unit of work fails while writing the ledger; later ones run as they are. */
function failingOnce(
  inner: UnitOfWork,
  failure: () => Error = () => new Error("the disk is on fire"),
): UnitOfWork {
  let failures = 1;
  return {
    run: <T>(work: (repositories: Repositories) => Promise<T>) =>
      inner.run((repositories) => {
        if (failures === 0) {
          return work(repositories);
        }
        failures -= 1;
        const { ledger } = repositories;
        return work({
          ...repositories,
          ledger: {
            add: () => Promise.reject(failure()),
            page: (walletId, options) => ledger.page(walletId, options),
            summarize: (walletId) => ledger.summarize(walletId),
          },
        });
      }),
  };
}
