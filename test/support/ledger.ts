import type { SQL } from "bun";

export interface LedgerDiscrepancy {
  readonly walletId: string;
  readonly balance: string;
  readonly rebuilt: string;
}

/**
 * Wallets whose stored balance differs from the balance rebuilt from the ledger: the credits to
 * the wallet's account minus the debits from it. The final invariant of every integration and
 * concurrency test is that this list is empty.
 */
export async function ledgerDiscrepancies(sql: SQL): Promise<LedgerDiscrepancy[]> {
  const rows: LedgerDiscrepancy[] = await sql`
    select w.id as "walletId", w.balance::text as balance, rebuilt.amount::text as rebuilt
    from wallets w
    cross join lateral (
      select coalesce(sum(case when e.credit_account_id = w.id then e.amount else -e.amount end), 0)
        ::numeric(20,2) as amount
      from ledger_entries e
      where e.credit_account_id = w.id or e.debit_account_id = w.id
    ) rebuilt
    where rebuilt.amount <> w.balance
    order by w.id`;
  return rows;
}
