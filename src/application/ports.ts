import type { EventContext, IntegrationEvent } from '../domain/events';
import type { WalletLedgerEntry } from '../domain/ledger';
import type { Money } from '../domain/money';
import type { WagerTransaction } from '../domain/transaction';
import type { Wallet } from '../domain/wallet';

export interface TransactionRecord {
  transaction: WagerTransaction;
  resultBalance: Money | null;
  attempts: number;
  nextAttemptAt: Date | null;
  correlationId: string;
}
export interface InboxRecord {
  payloadHash: string;
  transactionId: string;
}
export interface FinancialSession {
  lockKeys(keys: string[]): Promise<void>;
  wallet(id: string, lock?: boolean): Promise<Wallet | null>;
  insertWallet(wallet: Wallet): void;
  saveWallet(wallet: Wallet): Promise<void>;
  transactionByKey(key: string): Promise<TransactionRecord | null>;
  transactionByExternal(provider: string, externalId: string): Promise<TransactionRecord | null>;
  saveTransaction(record: TransactionRecord): Promise<void>;
  wasReversed(referenceId: string, kind: string): Promise<boolean>;
  insertLedger(entry: WalletLedgerEntry): void;
  enqueue(event: IntegrationEvent<unknown>): void;
  inbox(consumer: string, messageId: string): Promise<InboxRecord | null>;
  completeInbox(consumer: string, messageId: string, hash: string, transactionId: string): void;
}
export interface FinancialStore {
  atomic<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
}
export interface RequestContext extends EventContext {
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}
export interface ProviderIdentityPort {
  assertProvider(providerId: string, authorization?: string): Promise<void>;
}
export interface BrokerPort {
  publish(eventId: string, aggregateId: string, payload: Record<string, unknown>): Promise<void>;
}
