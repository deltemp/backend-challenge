import { LedgerAccount } from "../../domain/ledger/ledger-account";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { DuplicateKeyError, WalletAlreadyExistsError } from "../errors";
import { decisionEvents, enqueueEvents, eventContexts } from "../integration-events";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/id-generator";
import type { Repositories } from "../ports/repositories";
import type { UnitOfWork } from "../ports/unit-of-work";
import { RequestCheck } from "../request-limits";
import { type WalletView, walletView } from "../views";

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
}

/**
 * Opens a player's wallet in one currency. An initial balance above zero is credited by the
 * internal OPENING transaction in the same SQL transaction, with its ledger entry and its
 * events (`WagerTransactionProcessed`, `WalletBalanceChanged`); an opening at zero has neither.
 */
export class OpenWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    new RequestCheck().identifier("playerId", command.playerId).verify();
    const initialBalance = Money.from(command.initialBalance);
    try {
      return await this.unitOfWork.run((repositories) =>
        this.open(repositories, command, initialBalance),
      );
    } catch (error) {
      // A concurrent request opened the same wallet first.
      if (error instanceof DuplicateKeyError && error.key === "wallet-owner") {
        const existing = await this.unitOfWork.run(({ wallets }) =>
          wallets.findIdByOwner(command.playerId, initialBalance.currency),
        );
        throw new WalletAlreadyExistsError(existing);
      }
      throw error;
    }
  }

  private async open(
    repositories: Repositories,
    command: OpenWalletCommand,
    initialBalance: Money,
  ): Promise<WalletView> {
    const { wallets, accounts, transactions, ledger, outbox } = repositories;
    const existing = await wallets.findIdByOwner(command.playerId, initialBalance.currency);
    if (existing !== undefined) {
      throw new WalletAlreadyExistsError(existing);
    }

    const now = this.clock.now();
    const opening = initialBalance.isZero()
      ? undefined
      : {
          transactionId: this.ids.next(),
          entryId: this.ids.next(),
          fundingAccountId: await accounts.fundingAccount(initialBalance.currency),
        };
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      openedAt: now,
      opening,
    });
    await wallets.add(wallet);
    await accounts.add(LedgerAccount.forWallet(wallet, now));

    if (opening !== undefined && openingEntry !== undefined) {
      const transaction = WagerTransaction.opening({
        id: opening.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initialBalance,
        createdAt: now,
      });
      await transactions.add(transaction);
      await ledger.add(openingEntry);
      await enqueueEvents(
        outbox,
        decisionEvents(
          transaction,
          wallet,
          openingEntry,
          eventContexts(this.ids, now, command.correlationId),
        ),
      );
    }
    return walletView(wallet);
  }
}
