import { validateCurrency } from "../money/money";
import { InvariantViolationError } from "../shared/errors";

export enum LedgerAccountType {
  /** A player's wallet. */
  PlayerWallet = "PLAYER_WALLET",
  /** The counterparty of a provider's wagering movements, one per provider and currency. */
  ProviderSettlement = "PROVIDER_SETTLEMENT",
  /** The source of OPENING credits, one per currency. */
  Funding = "FUNDING",
}

export interface LedgerAccountState {
  readonly id: string;
  readonly type: LedgerAccountType;
  readonly currency: string;
  readonly walletId: string | undefined;
  readonly providerId: string | undefined;
  readonly createdAt: Date;
}

/**
 * An account of the double-entry ledger. Only wallets keep a stored balance: the balance of a
 * counter-account is always derived by summing its entries, so no row is updated by the
 * transactions of every wallet.
 */
export class LedgerAccount {
  private constructor(
    readonly id: string,
    readonly type: LedgerAccountType,
    readonly currency: string,
    readonly walletId: string | undefined,
    readonly providerId: string | undefined,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** A wallet's account shares the wallet's id, so a ledger row names the wallet directly. */
  static forWallet(
    wallet: { readonly id: string; readonly currency: string },
    createdAt: Date,
  ): LedgerAccount {
    return new LedgerAccount(
      wallet.id,
      LedgerAccountType.PlayerWallet,
      validateCurrency(wallet.currency),
      wallet.id,
      undefined,
      createdAt,
    );
  }

  static providerSettlement(props: {
    readonly id: string;
    readonly providerId: string;
    readonly currency: string;
    readonly createdAt: Date;
  }): LedgerAccount {
    if (props.providerId.length === 0) {
      throw new InvariantViolationError("a settlement account belongs to a provider");
    }
    return new LedgerAccount(
      props.id,
      LedgerAccountType.ProviderSettlement,
      validateCurrency(props.currency),
      undefined,
      props.providerId,
      props.createdAt,
    );
  }

  static funding(props: {
    readonly id: string;
    readonly currency: string;
    readonly createdAt: Date;
  }): LedgerAccount {
    return new LedgerAccount(
      props.id,
      LedgerAccountType.Funding,
      validateCurrency(props.currency),
      undefined,
      undefined,
      props.createdAt,
    );
  }

  /** Rebuilds a persisted account without validating it again. */
  static rehydrate(state: LedgerAccountState): LedgerAccount {
    return new LedgerAccount(
      state.id,
      state.type,
      state.currency,
      state.walletId,
      state.providerId,
      state.createdAt,
    );
  }
}
