import { DomainError } from './errors';
import { type LedgerDirection, WalletLedgerEntry } from './ledger';
import type { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(private readonly state: WalletState) {}

  static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_INPUT', 'Initial balance cannot be negative');
    }
    const now = new Date();
    return new Wallet({
      ...props,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet({ ...state });
  }
  get id() {
    return this.state.id;
  }
  get playerId() {
    return this.state.playerId;
  }
  get currency() {
    return this.state.currency;
  }
  get balance() {
    return this.state.balance;
  }
  get version() {
    return this.state.version;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  get updatedAt() {
    return new Date(this.state.updatedAt);
  }

  debit(money: Money, transactionId: string, reversal = false): WalletLedgerEntry {
    if (this.balance.isLessThan(money)) {
      throw new DomainError(
        reversal ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS',
        'Wallet cannot become negative',
      );
    }
    return this.move('DEBIT', money, transactionId);
  }

  credit(money: Money, transactionId: string): WalletLedgerEntry {
    return this.move('CREDIT', money, transactionId);
  }

  private move(direction: LedgerDirection, money: Money, transactionId: string): WalletLedgerEntry {
    const after = direction === 'CREDIT' ? this.balance.add(money) : this.balance.subtract(money);
    const now = new Date();
    const entry = WalletLedgerEntry.create({
      id: crypto.randomUUID(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this.balance,
      balanceAfter: after,
      walletVersion: this.version + 1,
      createdAt: now,
    });
    this.state.balance = after;
    this.state.version += 1;
    this.state.updatedAt = now;
    return entry;
  }
}
