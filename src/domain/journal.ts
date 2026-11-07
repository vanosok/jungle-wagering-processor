import { DomainError } from './errors';
import type { LedgerDirection, WalletLedgerEntry } from './ledger';
import type { Money } from './money';

export interface Posting {
  readonly account: string;
  readonly side: LedgerDirection;
  readonly money: Money;
}

/** Wallet is a liability account: credits increase the amount owed to the player. */
export class Journal {
  private constructor(
    public readonly ledgerId: string,
    public readonly postings: readonly Posting[],
  ) {
    Object.freeze(this);
  }

  static from(entry: WalletLedgerEntry): Journal {
    const postings = Object.freeze([
      Object.freeze({
        account: `wallet:${entry.walletId}`,
        side: entry.direction,
        money: entry.money,
      }),
      Object.freeze({
        account: `clearing:${entry.money.currency}`,
        side: entry.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
        money: entry.money,
      }),
    ]);
    const journal = new Journal(entry.id, postings);
    if (!journal.isBalanced()) throw new DomainError('INVALID_INPUT', 'Unbalanced journal');
    return journal;
  }
  isBalanced(): boolean {
    const [wallet, clearing] = this.postings;
    return (
      !!wallet &&
      !!clearing &&
      wallet.account !== clearing.account &&
      wallet.side !== clearing.side &&
      wallet.money.isPositive() &&
      wallet.money.equals(clearing.money)
    );
  }
}
