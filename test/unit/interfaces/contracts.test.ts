import { describe, expect, test } from "bun:test";
import { sleep } from "../../../src/interfaces/background";
import {
  ledgerQuery,
  openWalletBody,
  wagerTransactionBody,
} from "../../../src/interfaces/contracts";

const BODY = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

function issuesOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("request contracts", () => {
  test("money keeps the domain's rules: decimal strings, at most two places, ISO-4217 codes", () => {
    for (const [money, path] of [
      [{ amount: 25, currency: "BRL" }, "money.amount"],
      [{ amount: "25.001", currency: "BRL" }, "money.amount"],
      [{ amount: "1e3", currency: "BRL" }, "money.amount"],
      [{ amount: "-1.00", currency: "BRL" }, "money.amount"],
      [{ amount: "25.00", currency: "brl" }, "money.currency"],
    ] as const) {
      expect(issuesOf(wagerTransactionBody.safeParse({ ...BODY, money }))).toEqual([path]);
    }
  });

  test("identifiers keep the use cases' limits, and only submittable kinds pass", () => {
    expect(
      issuesOf(wagerTransactionBody.safeParse({ ...BODY, providerId: "p".repeat(65) })),
    ).toEqual(["providerId"]);
    // Control characters, unpaired surrogates, and the two characters SQS refuses in a message.
    for (const roundId of ["round\n1", "round-\ud800", "round-\uFFFF", "round-\uFFFE"]) {
      expect(issuesOf(wagerTransactionBody.safeParse({ ...BODY, roundId }))).toEqual(["roundId"]);
    }
    // Any other text passes, characters outside the BMP included.
    expect(wagerTransactionBody.safeParse({ ...BODY, roundId: "rodada-ção-🎰" }).success).toBe(
      true,
    );
    expect(issuesOf(wagerTransactionBody.safeParse({ ...BODY, kind: "OPENING" }))).toEqual([
      "kind",
    ]);
  });

  test("a wallet opening needs a player and an initial balance", () => {
    expect(
      openWalletBody.safeParse({ playerId: "p", initialBalance: { amount: "0", currency: "BRL" } })
        .success,
    ).toBe(true);
    expect(issuesOf(openWalletBody.safeParse({ playerId: "p" }))).toEqual(["initialBalance"]);
  });

  test("the ledger limit is an integer from 1 to 100", () => {
    expect(ledgerQuery.parse({ limit: "100" })).toEqual({ limit: 100 });
    expect(ledgerQuery.parse({})).toEqual({});
    for (const limit of ["0", "101", "1.5", "ten", ["1", "2"]]) {
      expect(issuesOf(ledgerQuery.safeParse({ limit }))).toEqual(["limit"]);
    }
  });
});

describe("sleep", () => {
  test("ends at once when its signal aborts", async () => {
    const controller = new AbortController();
    const sleeping = sleep(60_000, controller.signal);

    controller.abort();

    expect(await sleeping).toBeUndefined();
  });
});
