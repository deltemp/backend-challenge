import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import type { SubmitWagerTransactionCommand } from "../../src/application/use-cases/submit-wager-transaction";
import type { WagerTransactionView, WalletView } from "../../src/application/views";
import { type AppProcess, appEnvironment, startApp } from "../support/app-process";
import { cleanUp } from "../support/cleanup";
import { createTestDatabase, type TestDatabase } from "../support/databases";
import { eventually } from "../support/eventually";
import { call, openWalletOverHttp, submitOverHttp, submitUntilSettled } from "../support/http";
import { ledgerDiscrepancies } from "../support/ledger";
import {
  drained,
  eventOf,
  messagesIn,
  sendMessage,
  takeMessages,
  wagerMessage,
} from "../support/messaging";
import { metricValue } from "../support/metrics";
import { type OtlpReceiver, startOtlpReceiver } from "../support/otlp";
import { createTestQueues, createTestSqsClient, type TestQueues } from "../support/queues";
import { balanceOf, transactionCommand } from "../support/use-cases";

// Fast pacing, so asynchronous work settles within a test.
const FAST = {
  OUTBOX_POLL_INTERVAL_MS: "50",
  REFERENCE_RETRY_POLL_INTERVAL_MS: "50",
  REFERENCE_RETRY_BASE_MS: "50",
  REFERENCE_RETRY_CAP_MS: "200",
  SQS_RETRY_BASE_MS: "100",
  SQS_RETRY_CAP_MS: "400",
  OUTAGE_BACKOFF_BASE_MS: "50",
  OUTAGE_BACKOFF_CAP_MS: "500",
};

const money = (amount: string) => ({ amount, currency: "BRL" });

/** Starts the instances in parallel, keeping every one that started, so cleanup stops it. */
async function startInstances(
  environment: Record<string, string>,
  count: number,
  started: AppProcess[],
): Promise<AppProcess[]> {
  const results = await Promise.allSettled(
    Array.from({ length: count }, () => startApp(environment)),
  );
  const apps = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  started.push(...apps);
  const failure = results.find((result) => result.status === "rejected");
  if (failure !== undefined) {
    throw failure.reason;
  }
  await Promise.all(apps.map((app) => app.waitUntilReady()));
  return apps;
}

/**
 * A database and a queue set of its own for one describe, and the instances it starts. The
 * instances trace to an OTLP receiver of their own, as the compose replicas do to the collector,
 * so these scenarios run with the spans around every unit of work, message and publication.
 */
function environmentPerDescribe() {
  const sqs = createTestSqsClient();
  const started: AppProcess[] = [];
  let database: TestDatabase | undefined;
  let queues: TestQueues | undefined;
  let sql: SQL | undefined;
  let receiver: OtlpReceiver | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    queues = await createTestQueues(sqs);
    sql = new SQL(database.url);
    receiver = startOtlpReceiver();
  });

  afterAll(() =>
    cleanUp(
      () => Promise.all(started.map((app) => app.stop("SIGKILL"))),
      () => receiver?.stop(),
      () => sql?.close(),
      () => queues?.delete(),
      () => database?.drop(),
      () => sqs.destroy(),
    ),
  );

  afterEach(async () => {
    if (sql !== undefined) {
      expect(await ledgerDiscrepancies(sql)).toEqual([]);
    }
    // The instances did run with tracing on.
    await receiver?.waitForSpan("a span from the instances", () => true);
  });

  return {
    sqs,
    started,
    context(): {
      readonly sql: SQL;
      readonly queues: TestQueues;
      readonly env: Record<string, string>;
    } {
      if (
        database === undefined ||
        queues === undefined ||
        sql === undefined ||
        receiver === undefined
      ) {
        throw new Error("setup did not complete");
      }
      return {
        sql,
        queues,
        env: {
          ...appEnvironment(database, queues),
          ...FAST,
          OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
          TRACING_EXPORT_DELAY_MS: "50",
        },
      };
    },
  };
}

async function transactionStatus(baseUrl: string, transactionId: string): Promise<string> {
  const answer = await call(baseUrl, `/wagering/transactions/${transactionId}`);
  return (answer.body as WagerTransactionView).status;
}

async function debits(sql: SQL, wallet: WalletView): Promise<number> {
  const [row] = await sql`
    select count(*)::int as debits from ledger_entries
    where wallet_id = ${wallet.id} and direction = 'DEBIT'`;
  return Number(row?.debits);
}

function enqueue(sqs: SQSClient, queues: TestQueues, command: SubmitWagerTransactionCommand) {
  return sendMessage(sqs, queues.urls.wagerTransactions, wagerMessage(command), {
    groupId: command.walletId,
  });
}

// §13, concurrency 2, 1, 3, 4 and 7, with three real processes sharing one database and queues.
describe("three instances with every role", () => {
  const { sqs, started, context } = environmentPerDescribe();
  let apps: AppProcess[] = [];

  beforeAll(async () => {
    apps = await startInstances(context().env, 3, started);
  });

  function instance(index: number): string {
    const app = apps[index % apps.length];
    if (app === undefined) {
      throw new Error("no instance started");
    }
    return app.baseUrl;
  }

  test("§8 across instances: two 80.00 bets on 100.00 at once, one processed, one rejected, a single debit", async () => {
    const { sql } = context();
    const wallet = await openWalletOverHttp(instance(0), "100.00");

    const answers = await Promise.all([
      submitUntilSettled(
        instance(0),
        transactionCommand(wallet, { kind: "BET", money: money("80.00") }),
      ),
      submitUntilSettled(
        instance(1),
        transactionCommand(wallet, { kind: "BET", money: money("80.00") }),
      ),
    ]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 422]);
    expect(answers.map((answer) => answer.body)).toContainEqual(
      expect.objectContaining({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" }),
    );
    expect(await balanceOf(sql, wallet.id)).toBe("20.00");
    expect(await debits(sql, wallet)).toBe(1);
  });

  test("the same bet 50 times in parallel across the instances, over HTTP and the queue: a single debit", async () => {
    const { sql, queues } = context();
    const wallet = await openWalletOverHttp(instance(0), "100.00");
    const command = transactionCommand(wallet, { kind: "BET", money: money("10.00") });
    const redelivered = wagerMessage(command);

    const [answers] = await Promise.all([
      Promise.all(Array.from({ length: 30 }, (_, i) => submitUntilSettled(instance(i), command))),
      // Ten redeliveries of one message, and ten other messages with the same transaction.
      ...Array.from({ length: 10 }, () =>
        sendMessage(sqs, queues.urls.wagerTransactions, redelivered, { groupId: wallet.id }),
      ),
      ...Array.from({ length: 10 }, () => enqueue(sqs, queues, command)),
    ]);
    await drained(sqs, queues.urls.wagerTransactions);

    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    const firsts = answers.filter(
      (answer) => !(answer.body as { idempotentReplay: boolean }).idempotentReplay,
    );
    expect(firsts.length).toBeLessThanOrEqual(1);
    const [stored] = await sql`
      select count(*)::int as transactions from wager_transactions
      where idempotency_key = ${command.idempotencyKey}`;
    expect(stored).toEqual({ transactions: 1 });
    expect(await debits(sql, wallet)).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe("90.00");
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });

  test("distinct wallets in parallel across the instances: every bet applied to its own wallet", async () => {
    const { sql, queues } = context();
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => openWalletOverHttp(instance(i), "100.00")),
    );

    await Promise.all(
      wallets.flatMap((wallet, w) =>
        Array.from({ length: 5 }, (_, b) => {
          const command = transactionCommand(wallet, { kind: "BET", money: money("20.00") });
          return (w + b) % 2 === 0
            ? submitUntilSettled(instance(b), command)
            : enqueue(sqs, queues, command);
        }),
      ),
    );
    await drained(sqs, queues.urls.wagerTransactions);

    for (const wallet of wallets) {
      expect(await balanceOf(sql, wallet.id)).toBe("0.00");
      expect(await debits(sql, wallet)).toBe(5);
    }
  });

  test("a REFUND delivered before its BET, through other instances, is applied once the BET arrives", async () => {
    const { sql, queues } = context();
    const wallet = await openWalletOverHttp(instance(0), "100.00");
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refund = await submitOverHttp(
      instance(1),
      transactionCommand(wallet, {
        kind: "REFUND",
        money: money("30.00"),
        referenceExternalTransactionId: betId,
      }),
    );
    expect(refund.status).toBe(202);
    const { transactionId } = refund.body as { transactionId: string };

    await enqueue(
      sqs,
      queues,
      transactionCommand(wallet, {
        kind: "BET",
        money: money("30.00"),
        externalTransactionId: betId,
      }),
    );

    await eventually("the REFUND applied", async () =>
      (await transactionStatus(instance(2), transactionId)) === "PROCESSED" ? true : undefined,
    );
    expect(await balanceOf(sql, wallet.id)).toBe("100.00");
  });
});

// §13, concurrency 5: a real process killed at the exact point between commit and acknowledgement.
describe("a consumer killed after the commit and before the acknowledgement", () => {
  const { sqs, started, context } = environmentPerDescribe();

  test("the redelivery is answered from the inbox and does nothing again", async () => {
    const { sql, queues, env } = context();
    const [api] = await startInstances({ ...env, APP_ROLES: "api" }, 1, started);
    // The victim holds each message a minute after its commit; its visibility ends sooner.
    const [victim] = await startInstances(
      {
        ...env,
        APP_ROLES: "consumer",
        TEST_CONSUMER_ACK_DELAY_MS: "60000",
        SQS_VISIBILITY_TIMEOUT_SECONDS: "2",
        SQS_RECEIVE_WAIT_SECONDS: "1",
      },
      1,
      started,
    );
    if (api === undefined || victim === undefined) {
      throw new Error("instances not started");
    }
    const wallet = await openWalletOverHttp(api.baseUrl, "100.00");
    const command = transactionCommand(wallet, { kind: "BET", money: money("40.00") });
    const message = wagerMessage(command);
    await sendMessage(sqs, queues.urls.wagerTransactions, message, { groupId: wallet.id });

    await eventually("the commit", async () => {
      const [row] = await sql`
        select count(*)::int as committed from wager_transactions
        where idempotency_key = ${command.idempotencyKey}`;
      return row?.committed === 1 ? true : undefined;
    });
    await victim.stop("SIGKILL");
    const [rescuer] = await startInstances({ ...env, APP_ROLES: "consumer" }, 1, started);
    if (rescuer === undefined) {
      throw new Error("rescuer not started");
    }

    await drained(sqs, queues.urls.wagerTransactions);
    const [counts] = await sql`
      select
        (select count(*)::int from wager_transactions
          where idempotency_key = ${command.idempotencyKey}) as transactions,
        (select count(*)::int from inbox_messages where message_id = ${message.messageId}) as inbox`;
    expect(counts).toEqual({ transactions: 1, inbox: 1 });
    expect(await debits(sql, wallet)).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe("60.00");
    expect(
      await metricValue(rescuer.baseUrl, "wager_duplicates_total", {
        source: "sqs",
        type: "duplicate_message",
      }),
    ).toBe(1);
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });
});

// §11 and §13, concurrency 6: two publisher processes over one outbox.
describe("two publishers over the same outbox, in two processes", () => {
  const { sqs, started, context } = environmentPerDescribe();

  test("every event is published once, and each wallet's events keep their commit order", async () => {
    const { sql, queues, env } = context();
    const [api] = await startInstances({ ...env, APP_ROLES: "api" }, 1, started);
    const publishers = await startInstances({ ...env, APP_ROLES: "outbox" }, 2, started);
    if (api === undefined) {
      throw new Error("api not started");
    }
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => openWalletOverHttp(api.baseUrl, "100.00")),
    );
    for (const wallet of wallets) {
      for (let bet = 0; bet < 3; bet += 1) {
        await submitOverHttp(api.baseUrl, transactionCommand(wallet, { kind: "BET" }));
      }
    }
    // The OPENING and three BETs per wallet, each with its balance change.
    const expected = wallets.length * 8;

    const events = (await takeMessages(sqs, queues.urls.wagerEvents, expected)).map(eventOf);

    expect(new Set(events.map((event) => event.eventId)).size).toBe(expected);
    for (const wallet of wallets) {
      const versions = events
        .filter(
          (event) => event.eventType === "WalletBalanceChanged" && event.aggregateId === wallet.id,
        )
        .map((event) => event.data.walletVersion);
      expect(versions).toEqual([1, 2, 3, 4]);
    }
    const [pending] = await sql`
      select count(*)::int as pending from outbox_messages where published_at is null`;
    expect(pending).toEqual({ pending: 0 });
    const published = await Promise.all(
      publishers.map((publisher) =>
        metricValue(publisher.baseUrl, "outbox_events_published_total"),
      ),
    );
    expect(published.reduce((sum, count) => sum + count, 0)).toBe(expected);
  });
});

// §13, concurrency 8: every instance killed mid-traffic, then started again.
describe("a restart of every instance", () => {
  const { sqs, started, context } = environmentPerDescribe();

  test("traffic interrupted by killing every instance ends consistent once they are back", async () => {
    const { sql, queues } = context();
    // The messages the killed consumers held come back when their visibility timeout ends.
    const env = {
      ...context().env,
      SQS_VISIBILITY_TIMEOUT_SECONDS: "3",
      SQS_RECEIVE_WAIT_SECONDS: "1",
    };
    const before = await startInstances(env, 3, started);
    const baseUrl = (index: number) => before[index % before.length]?.baseUrl ?? "";
    const httpWallets = await Promise.all(
      Array.from({ length: 4 }, (_, i) => openWalletOverHttp(baseUrl(i), "100.00")),
    );
    const queueWallets = await Promise.all(
      Array.from({ length: 4 }, (_, i) => openWalletOverHttp(baseUrl(i), "100.00")),
    );
    const httpCommands = httpWallets.flatMap((wallet) =>
      Array.from({ length: 6 }, () =>
        transactionCommand(wallet, { kind: "BET", money: money("5.00") }),
      ),
    );
    const queueCommands = queueWallets.flatMap((wallet) =>
      Array.from({ length: 6 }, () =>
        transactionCommand(wallet, { kind: "BET", money: money("5.00") }),
      ),
    );

    // Traffic in flight while every instance is killed: some requests never get an answer.
    await Promise.all(queueCommands.map((command) => enqueue(sqs, queues, command)));
    const inFlight = httpCommands.map((command, i) =>
      submitOverHttp(baseUrl(i), command).catch(() => undefined),
    );
    await eventually("some traffic committed", async () => {
      const [row] = await sql`
        select count(*)::int as committed from wager_transactions where kind = 'BET'`;
      return Number(row?.committed) >= 8 ? true : undefined;
    });
    await Promise.all(before.map((app) => app.stop("SIGKILL")));
    await Promise.all(inFlight);

    const after = await startInstances(env, 3, started);
    // A provider resends what got no answer, with the same key; replays are harmless.
    await Promise.all(
      httpCommands.map((command, i) =>
        submitUntilSettled(after[i % after.length]?.baseUrl ?? "", command),
      ),
    );
    await drained(sqs, queues.urls.wagerTransactions);
    await eventually("the outbox drained", async () => {
      const [row] = await sql`
        select count(*)::int as pending from outbox_messages where published_at is null`;
      return row?.pending === 0 ? true : undefined;
    });

    for (const wallet of [...httpWallets, ...queueWallets]) {
      expect(await balanceOf(sql, wallet.id)).toBe("70.00");
      expect(await debits(sql, wallet)).toBe(6);
    }
    const [stored] = await sql`
      select count(*)::int as bets, count(distinct idempotency_key)::int as keys
      from wager_transactions where kind = 'BET'`;
    expect(stored).toEqual({ bets: 48, keys: 48 });
    expect(await messagesIn(sqs, queues.urls.wagerTransactionsDlq)).toBe(0);
  });
});
