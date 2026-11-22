import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { WalletView } from "../../src/application/views";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { call, httpBody, openWalletOverHttp, submitOverHttp } from "../support/http";
import { ledgerDiscrepancies } from "../support/ledger";
import { metricValue } from "../support/metrics";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { balanceOf, deferred, transactionCommand } from "../support/use-cases";

interface Submission {
  readonly transactionId: string;
}

interface LedgerPageBody {
  readonly entries: readonly { readonly walletVersion: number }[];
  readonly nextCursor: string | null;
}

// §9 over a real process: status codes, problem details, idempotency and the queries. The
// process runs the API alone, so no worker publishes or reprocesses behind the tests' backs.
describe("wagering HTTP API", () => {
  const sqs = createTestSqsClient();
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let app: AppProcess | undefined;

  function setup(): { readonly baseUrl: string; readonly sql: SQL } {
    if (app === undefined || sql === undefined) {
      throw new Error("setup did not complete");
    }
    return { baseUrl: app.baseUrl, sql };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    sql = new SQL(database.url);
    app = await startApp({
      ...appEnvironment(database, queues),
      APP_ROLES: "api",
      DATABASE_LOCK_TIMEOUT_MS: "300",
    });
    await app.waitUntilReady();
  });

  afterAll(() =>
    cleanUp(
      () => app?.stop(),
      () => sql?.close(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    expect(await ledgerDiscrepancies(setup().sql)).toEqual([]);
  });

  test("POST /wallets answers 201 with the wallet; an initial balance is an OPENING credit in its ledger", async () => {
    const { baseUrl } = setup();

    const answer = await call(baseUrl, "/wallets", {
      json: { playerId: "player-http-1", initialBalance: { amount: "1000.00", currency: "BRL" } },
    });

    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({
      playerId: "player-http-1",
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    const wallet = answer.body as WalletView;
    expect((await call(baseUrl, `/wallets/${wallet.id}`)).body).toEqual(wallet);
    expect((await call(baseUrl, `/wallets/${wallet.id}/ledger`)).body).toMatchObject({
      walletId: wallet.id,
      nextCursor: null,
      entries: [
        { walletVersion: 1, direction: "CREDIT", money: { amount: "1000.00", currency: "BRL" } },
      ],
    });
  });

  test("a second wallet for the same player and currency is 409 WALLET_ALREADY_EXISTS, as problem details", async () => {
    const { baseUrl } = setup();
    const body = {
      playerId: "player-http-2",
      initialBalance: { amount: "10.00", currency: "BRL" },
    };
    const first = await call(baseUrl, "/wallets", { json: body });

    const second = await call(baseUrl, "/wallets", {
      json: body,
      headers: { "x-correlation-id": "duplicate-wallet-1" },
    });

    expect(second.status).toBe(409);
    expect(second.headers.get("content-type")).toContain("application/problem+json");
    expect(second.body).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: expect.any(String),
      instance: "/wallets",
      code: "WALLET_ALREADY_EXISTS",
      correlationId: "duplicate-wallet-1",
      walletId: (first.body as WalletView).id,
    });
  });

  test("a request that breaks the contract is 400 VALIDATION_FAILED, listing every broken field", async () => {
    const { baseUrl } = setup();

    const answer = await call(baseUrl, "/wallets", {
      json: { playerId: "", initialBalance: { amount: 10, currency: "brl" }, extra: true },
    });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ status: 400, code: "VALIDATION_FAILED" });
    const paths = (answer.body as { errors: { path: string }[] }).errors.map((issue) => issue.path);
    // The unknown field is reported at the root: an empty path.
    expect(paths.sort()).toEqual([
      "",
      "initialBalance.amount",
      "initialBalance.currency",
      "playerId",
    ]);
  });

  test("a body that is not JSON is 400 MALFORMED_JSON, and one over the limit is 413 PAYLOAD_TOO_LARGE", async () => {
    const { baseUrl } = setup();

    const malformed = await call(baseUrl, "/wagering/transactions", {
      raw: '{"providerId": ',
      headers: { "idempotency-key": "key-1" },
    });
    const large = await call(baseUrl, "/wallets", {
      raw: JSON.stringify({ playerId: "p".repeat(20_000) }),
    });

    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: "MALFORMED_JSON",
      instance: "/wagering/transactions",
    });
    expect(large.status).toBe(413);
    expect(large.body).toMatchObject({ code: "PAYLOAD_TOO_LARGE", title: "Content Too Large" });
  });

  test("an unknown route is 404 ROUTE_NOT_FOUND", async () => {
    const answer = await call(setup().baseUrl, "/no-such-route");

    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: "ROUTE_NOT_FOUND", instance: "/no-such-route" });
  });

  test("a processed BET is 200 with the balance it left; the identical request gets the same answer, as a replay", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    const command = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    const first = await submitOverHttp(baseUrl, command);
    const replay = await submitOverHttp(baseUrl, command);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      failureCode: null,
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...(first.body as Submission), idempotentReplay: true });
  });

  test("the Idempotency-Key header is required, whatever else the request breaks", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);

    const missing = await call(baseUrl, "/wagering/transactions", { json: { kind: "OPENING" } });
    const blank = await call(baseUrl, "/wagering/transactions", {
      json: {},
      headers: { "idempotency-key": "  " },
    });
    const tooLong = await call(baseUrl, "/wagering/transactions", {
      json: httpBody(transactionCommand(wallet, { kind: "BET" })),
      headers: { "idempotency-key": "k".repeat(256) },
    });

    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ path: "Idempotency-Key", message: "must have 1 to 255 characters" }],
    });
  });

  test("the same key with another payload is 409 IDEMPOTENCY_CONFLICT; the same provider id under another key, 409 EXTERNAL_TRANSACTION_CONFLICT", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);
    const command = transactionCommand(wallet, { kind: "BET" });
    expect((await submitOverHttp(baseUrl, command)).status).toBe(200);

    const otherPayload = await submitOverHttp(baseUrl, {
      ...command,
      money: { amount: "11.00", currency: "BRL" },
    });
    const otherKey = await submitOverHttp(baseUrl, {
      ...command,
      idempotencyKey: `other-${command.idempotencyKey}`,
    });

    expect(otherPayload.status).toBe(409);
    expect(otherPayload.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(otherKey.status).toBe(409);
    expect(otherKey.body).toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
  });

  test("a business rejection is 422 with the transaction and its failure code, on the first call and on a replay", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "10.00");
    const command = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "80.00", currency: "BRL" },
    });

    const first = await submitOverHttp(baseUrl, command);
    const replay = await submitOverHttp(baseUrl, command);

    expect(first.status).toBe(422);
    expect(first.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...(first.body as Submission), idempotentReplay: true });
  });

  test("a reversal that arrives before its reference is 202 PENDING_REFERENCE", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);

    const answer = await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, {
        kind: "REFUND",
        referenceExternalTransactionId: `bet-${Bun.randomUUIDv7()}`,
      }),
    );

    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({
      status: "PENDING_REFERENCE",
      failureCode: null,
      idempotentReplay: false,
    });
  });

  test("OPENING, a numeric amount, an uppercase wallet id, an unknown field and a REFUND without reference are 400 VALIDATION_FAILED", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);
    const command = transactionCommand(wallet, { kind: "BET" });
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "OPENING" }, "kind"],
      [{ money: { amount: 10, currency: "BRL" } }, "money.amount"],
      [{ walletId: wallet.id.toUpperCase() }, "walletId"],
      [{ amount: "10.00" }, ""],
    ];

    for (const [overrides, path] of cases) {
      const answer = await call(baseUrl, "/wagering/transactions", {
        json: { ...httpBody(command), ...overrides },
        headers: { "idempotency-key": command.idempotencyKey },
      });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: expect.arrayContaining([expect.objectContaining({ path })]),
      });
    }
    // The domain's contract has no single field: the request as a whole, an empty path.
    const refund = await submitOverHttp(baseUrl, transactionCommand(wallet, { kind: "REFUND" }));
    expect(refund.status).toBe(400);
    expect(refund.body).toMatchObject({
      code: "VALIDATION_FAILED",
      errors: [{ path: "", message: "REFUND needs referenceExternalTransactionId" }],
    });
  });

  test("an unknown wallet is 404 WALLET_NOT_FOUND, an unknown transaction 404 TRANSACTION_NOT_FOUND", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);

    const unknownWallet = await submitOverHttp(
      baseUrl,
      transactionCommand({ ...wallet, id: Bun.randomUUIDv7() }, { kind: "BET" }),
    );

    expect(unknownWallet.status).toBe(404);
    expect(unknownWallet.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
    for (const path of [
      `/wallets/${Bun.randomUUIDv7()}`,
      `/wallets/not-a-wallet/ledger`,
      `/wagering/transactions/${Bun.randomUUIDv7()}`,
      // A NUL never reaches PostgreSQL: it matches nothing.
      "/providers/provider-a/wagering/transactions/txn%00",
    ]) {
      const answer = await call(baseUrl, path);
      expect(answer.status).toBe(404);
    }
  });

  test("lookups answer 200 with the transaction, whatever its status", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "1.00");
    const command = transactionCommand(wallet, {
      kind: "BET",
      money: { amount: "5.00", currency: "BRL" },
    });
    const { transactionId } = (await submitOverHttp(baseUrl, command)).body as Submission;

    const byId = await call(baseUrl, `/wagering/transactions/${transactionId}`);
    const byExternalId = await call(
      baseUrl,
      `/providers/${command.providerId}/wagering/transactions/${command.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: transactionId,
      kind: "BET",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
    });
    expect(byExternalId.status).toBe(200);
    expect(byExternalId.body).toEqual(byId.body);
  });

  test("a FAILED transaction answers 422 on a replay of its key, and 200 on a lookup", async () => {
    const { baseUrl, sql } = setup();
    const wallet = await openWalletOverHttp(baseUrl);
    const command = transactionCommand(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: `bet-${Bun.randomUUIDv7()}`,
    });
    const { transactionId } = (await submitOverHttp(baseUrl, command)).body as Submission;
    // Only reprocessing fails a parked transaction, and the schema allows exactly that move.
    await sql`
      update wager_transactions
      set status = 'FAILED', failure_code = 'INTERNAL_ERROR', next_attempt_at = null
      where id = ${transactionId}`;

    const replay = await submitOverHttp(baseUrl, command);
    const lookup = await call(baseUrl, `/wagering/transactions/${transactionId}`);

    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      transactionId,
      status: "FAILED",
      failureCode: "INTERNAL_ERROR",
      idempotentReplay: true,
    });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ status: "FAILED", failureCode: "INTERNAL_ERROR" });
  });

  test("the ledger pages newest first through an opaque cursor; a cursor it did not issue and a limit out of range are 400", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    for (let bet = 0; bet < 3; bet += 1) {
      await submitOverHttp(baseUrl, transactionCommand(wallet, { kind: "BET" }));
    }

    const first = (await call(baseUrl, `/wallets/${wallet.id}/ledger?limit=2`))
      .body as LedgerPageBody;
    const second = (
      await call(baseUrl, `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`)
    ).body as LedgerPageBody;

    expect(first.entries.map((entry) => entry.walletVersion)).toEqual([4, 3]);
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    // Whatever its length, a cursor this service did not issue is INVALID_CURSOR.
    for (const cursor of ["bm90LWEtY3Vyc29y", "A".repeat(200)]) {
      expect(
        (await call(baseUrl, `/wallets/${wallet.id}/ledger?cursor=${cursor}`)).body,
      ).toMatchObject({ code: "INVALID_CURSOR" });
    }
    for (const limit of ["0", "101", "ten"]) {
      const answer = await call(baseUrl, `/wallets/${wallet.id}/ledger?limit=${limit}`);
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [expect.objectContaining({ path: "limit" })],
      });
    }
  });

  test("reconciliation answers the statement's shape; a divergence is flagged and counted, never corrected", async () => {
    const { baseUrl, sql } = setup();
    const wallet = await openWalletOverHttp(baseUrl, "100.00");
    await submitOverHttp(
      baseUrl,
      transactionCommand(wallet, { kind: "BET", money: { amount: "12.34", currency: "BRL" } }),
    );

    const consistent = await call(baseUrl, `/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    });

    expect(consistent.status).toBe(200);
    expect(consistent.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "87.66", currency: "BRL" },
      calculatedBalance: { amount: "87.66", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
      version: 2,
    });

    // The schema refuses this; only a session that disables triggers can corrupt a balance.
    const corrupt = (delta: string) =>
      sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update wallets set balance = balance + ${delta}::numeric where id = ${wallet.id}`;
      });
    const divergencesBefore = await metricValue(baseUrl, "reconciliation_divergences_total");
    await corrupt("5.00");
    try {
      const diverged = await call(baseUrl, `/wallets/${wallet.id}/reconciliation`, {
        method: "POST",
      });

      expect(diverged.status).toBe(200);
      expect(diverged.body).toMatchObject({
        consistent: false,
        difference: { amount: "5.00", currency: "BRL" },
      });
      expect(await metricValue(baseUrl, "reconciliation_divergences_total")).toBe(
        divergencesBefore + 1,
      );
      expect(await balanceOf(sql, wallet.id)).toBe("92.66");
    } finally {
      await corrupt("-5.00");
    }
  });

  test("a contended wallet is 503 WALLET_BUSY with Retry-After; nothing is committed, so resending is safe", async () => {
    const { baseUrl, sql } = setup();
    const wallet = await openWalletOverHttp(baseUrl);
    const command = transactionCommand(wallet, { kind: "BET" });
    const locked = deferred();
    const release = deferred();
    const holder = sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${wallet.id} for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    try {
      const busy = await submitOverHttp(baseUrl, command);

      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("1");
      expect(busy.body).toMatchObject({ code: "WALLET_BUSY" });
    } finally {
      release.resolve();
      await holder;
    }
    expect((await submitOverHttp(baseUrl, command)).body).toMatchObject({
      status: "PROCESSED",
      idempotentReplay: false,
    });
  });

  test("the business metrics and the gauges of shared state are exposed", async () => {
    const { baseUrl } = setup();
    const wallet = await openWalletOverHttp(baseUrl);
    const command = transactionCommand(wallet, { kind: "BET" });
    await submitOverHttp(baseUrl, command);
    await submitOverHttp(baseUrl, command);

    expect(
      await metricValue(baseUrl, "wager_transactions_total", {
        source: "http",
        kind: "BET",
        status: "PROCESSED",
      }),
    ).toBeGreaterThan(0);
    expect(
      await metricValue(baseUrl, "wager_duplicates_total", {
        source: "http",
        type: "idempotent_replay",
      }),
    ).toBeGreaterThan(0);
    expect(
      await metricValue(baseUrl, "wager_processing_duration_seconds_count", {
        source: "http",
        outcome: "processed",
      }),
    ).toBeGreaterThan(0);
    // This process runs no outbox worker: every event written so far still waits.
    expect(await metricValue(baseUrl, "outbox_pending_events")).toBeGreaterThan(0);
    // Its age mixes the database's clock with this host's, so only its presence is exact.
    expect(await metricValue(baseUrl, "outbox_lag_seconds")).toBeGreaterThanOrEqual(0);
    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    for (const gauge of [
      "outbox_lag_seconds",
      "outbox_events_over_attempt_threshold",
      "wager_pending_references",
      "sqs_dlq_messages",
    ]) {
      expect(text).toContain(`\n${gauge} `);
    }
  });
});
