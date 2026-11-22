import { describe, expect, test } from "bun:test";
import { LedgerAccount, LedgerAccountType } from "../../../src/domain/ledger/ledger-account";
import { InvalidMoneyError, InvariantViolationError } from "../../../src/domain/shared/errors";
import { T0 } from "./fixtures";

describe("LedgerAccount", () => {
  test("a wallet's account shares the wallet's id", () => {
    const account = LedgerAccount.forWallet({ id: "wallet-1", currency: "BRL" }, T0);

    expect(account).toMatchObject({
      id: "wallet-1",
      type: LedgerAccountType.PlayerWallet,
      currency: "BRL",
      walletId: "wallet-1",
      providerId: undefined,
    });
  });

  test("a settlement account belongs to one provider and currency", () => {
    const account = LedgerAccount.providerSettlement({
      id: "settlement-1",
      providerId: "provider-a",
      currency: "BRL",
      createdAt: T0,
    });

    expect(account).toMatchObject({
      type: LedgerAccountType.ProviderSettlement,
      providerId: "provider-a",
      walletId: undefined,
    });
    expect(() =>
      LedgerAccount.providerSettlement({
        id: "settlement-2",
        providerId: "",
        currency: "BRL",
        createdAt: T0,
      }),
    ).toThrow(InvariantViolationError);
  });

  test("a funding account belongs to one currency", () => {
    const account = LedgerAccount.funding({ id: "funding-1", currency: "BRL", createdAt: T0 });

    expect(account.type).toBe(LedgerAccountType.Funding);
    expect(() =>
      LedgerAccount.funding({ id: "funding-2", currency: "real", createdAt: T0 }),
    ).toThrow(InvalidMoneyError);
  });

  test("is immutable", () => {
    expect(
      Object.isFrozen(LedgerAccount.funding({ id: "f", currency: "BRL", createdAt: T0 })),
    ).toBe(true);
  });
});
