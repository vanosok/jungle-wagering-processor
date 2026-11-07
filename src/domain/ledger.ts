import { DomainError } from './errors';
import type { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    Object.freeze(state);
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(state);
    if (!state.money.isPositive() || state.balanceAfter.isNegative() || !entry.isBalanced()) {
      throw new DomainError('INVALID_INPUT', 'Unbalanced or non-positive ledger entry');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get id() {
    return this.state.id;
  }
  get walletId() {
    return this.state.walletId;
  }
  get transactionId() {
    return this.state.transactionId;
  }
  get direction() {
    return this.state.direction;
  }
  get money() {
    return this.state.money;
  }
  get balanceBefore() {
    return this.state.balanceBefore;
  }
  get balanceAfter() {
    return this.state.balanceAfter;
  }
  get walletVersion() {
    return this.state.walletVersion;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }

  isBalanced(): boolean {
    const { balanceBefore, balanceAfter, money, direction } = this.state;
    return (
      direction === 'CREDIT' ? balanceBefore.add(money) : balanceBefore.subtract(money)
    ).equals(balanceAfter);
  }
}
