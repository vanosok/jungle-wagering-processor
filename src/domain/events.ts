import type { FailureCode } from './errors';
import type { LedgerDirection, WalletLedgerEntry } from './ledger';
import type { MoneyProps } from './money';
import type { WagerTransaction } from './transaction';
import type { Wallet } from './wallet';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}
export interface IntegrationEventProps<T> extends EventContext {
  eventId: string;
  aggregateId: string;
  occurredAt: Date;
  data: T;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = freezeDeep(structuredClone(props.data));
  }
  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      data: this.data,
    };
  }
}

interface TransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  status: string;
  failureCode?: FailureCode;
}

function transactionProps(
  tx: WagerTransaction,
  ctx: EventContext,
): IntegrationEventProps<TransactionEventData> {
  return {
    ...ctx,
    eventId: crypto.randomUUID(),
    aggregateId: tx.walletId,
    occurredAt: new Date(),
    data: {
      transactionId: tx.id,
      walletId: tx.walletId,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      kind: tx.kind,
      status: tx.status,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    },
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionProcessed(transactionProps(tx, ctx));
  }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionRejected(transactionProps(tx, ctx));
  }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static from(tx: WagerTransaction, ctx: EventContext) {
    return new WagerTransactionPendingReference(transactionProps(tx, ctx));
  }
}

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext) {
    return new WalletBalanceChanged({
      ...ctx,
      eventId: crypto.randomUUID(),
      aggregateId: wallet.id,
      occurredAt: entry.createdAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
