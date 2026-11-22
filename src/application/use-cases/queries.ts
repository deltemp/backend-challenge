import type { MoneyProps } from "../../domain/money/money";
import { TransactionNotFoundError, WalletNotFoundError } from "../errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "../ledger-cursor";
import type { UnitOfWork } from "../ports/unit-of-work";
import { isUuid } from "../request-limits";
import {
  type LedgerEntryView,
  ledgerEntryView,
  type WagerTransactionView,
  type WalletView,
  wagerTransactionView,
  walletView,
} from "../views";

export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: { readonly walletId: string }): Promise<WalletView> {
    if (!isUuid(query.walletId)) {
      throw new WalletNotFoundError(query.walletId);
    }
    const wallet = await this.unitOfWork.run(({ wallets }) => wallets.find(query.walletId));
    if (wallet === undefined) {
      throw new WalletNotFoundError(query.walletId);
    }
    return walletView(wallet);
  }
}

export interface GetWalletLedgerQuery {
  readonly walletId: string;
  /** From the previous page's `nextCursor`; absent for the first page. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface LedgerPage {
  readonly walletId: string;
  /** Newest first. */
  readonly entries: readonly LedgerEntryView[];
  /** Opaque cursor of the next, older page; null on the last one. */
  readonly nextCursor: string | null;
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;

/** A wallet's ledger, newest entry first, paginated by wallet version. */
export class GetWalletLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: GetWalletLedgerQuery): Promise<LedgerPage> {
    const beforeVersion = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);
    // The API validates the limit; this only keeps the query bounded whatever it receives.
    const requested = Math.trunc(query.limit ?? LEDGER_PAGE_DEFAULT);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), LEDGER_PAGE_MAX)
      : LEDGER_PAGE_DEFAULT;
    if (!isUuid(query.walletId)) {
      throw new WalletNotFoundError(query.walletId);
    }
    return this.unitOfWork.run(async ({ wallets, ledger }) => {
      if ((await wallets.find(query.walletId)) === undefined) {
        throw new WalletNotFoundError(query.walletId);
      }
      // One more than the page: its presence says whether an older page exists.
      const entries = await ledger.page(query.walletId, { beforeVersion, limit: limit + 1 });
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        walletId: query.walletId,
        entries: page.map(ledgerEntryView),
        nextCursor:
          entries.length > limit && last !== undefined
            ? encodeLedgerCursor(last.walletVersion)
            : null,
      };
    });
  }
}

export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(query: { readonly transactionId: string }): Promise<WagerTransactionView> {
    if (!isUuid(query.transactionId)) {
      throw new TransactionNotFoundError();
    }
    const transaction = await this.unitOfWork.run(({ transactions }) =>
      transactions.find(query.transactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError();
    }
    return wagerTransactionView(transaction);
  }

  async byExternalId(query: {
    readonly providerId: string;
    readonly externalTransactionId: string;
  }): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.run(({ transactions }) =>
      transactions.findByExternalId(query.providerId, query.externalTransactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError();
    }
    return wagerTransactionView(transaction);
  }
}

/** The shape of the statement's reconciliation response (§9), plus the version checked. */
export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  /** Stored minus calculated. */
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  /** The wallet version the snapshot ended at. */
  readonly version: number;
}

/**
 * Compares a wallet's stored balance with the balance rebuilt from its ledger, both read in one
 * snapshot, so concurrent transactions cannot produce a false divergence. It never corrects
 * anything: the caller logs and counts a divergence.
 */
export class ReconcileWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: { readonly walletId: string }): Promise<ReconciliationReport> {
    if (!isUuid(query.walletId)) {
      throw new WalletNotFoundError(query.walletId);
    }
    const summary = await this.unitOfWork.run(({ ledger }) => ledger.summarize(query.walletId));
    if (summary === undefined) {
      throw new WalletNotFoundError(query.walletId);
    }
    const difference = summary.storedBalance.subtract(summary.calculatedBalance);
    return {
      walletId: summary.walletId,
      storedBalance: summary.storedBalance.toJSON(),
      calculatedBalance: summary.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: summary.entries,
      version: summary.version,
    };
  }
}
