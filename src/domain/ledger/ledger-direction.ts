/** The side of an entry seen from the wallet: a DEBIT lowers its balance, a CREDIT raises it. */
export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
