import { EntitySchema } from '@mikro-orm/core';
import type { FailureCode } from '../../domain/errors';
import type { LedgerDirection } from '../../domain/ledger';
import type { TransactionKind, TransactionStatus } from '../../domain/transaction';

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}
export class TransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: TransactionKind;
  amount!: string;
  currency!: string;
  status!: TransactionStatus;
  referenceExternalTransactionId: string | null = null;
  referenceTransactionId: string | null = null;
  failureCode: FailureCode | null = null;
  resultBalance: string | null = null;
  attempts = 0;
  nextAttemptAt: Date | null = null;
  correlationId!: string;
  createdAt!: Date;
  processedAt: Date | null = null;
}
export class LedgerRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}
export class InboxRow {
  id!: string;
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transactionId!: string;
  receivedAt!: Date;
  processedAt!: Date;
}
export class OutboxRow {
  traceContext: Record<string, string> = {};
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts = 0;
  nextAttemptAt!: Date;
  publishedAt: Date | null = null;
  leaseOwner: string | null = null;
  leaseUntil: Date | null = null;
}
export class PostingRow {
  id!: string;
  ledgerId!: string;
  account!: string;
  side!: LedgerDirection;
  amount!: string;
  currency!: string;
}

const id = { type: 'uuid', primary: true } as const;
const text = { type: 'string', columnType: 'text' } as const;
const money = { type: 'string', columnType: 'numeric(20,2)' } as const;
const timestamp = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id,
    playerId: { type: 'uuid' },
    currency: text,
    balance: money,
    version: { type: 'integer' },
    createdAt: timestamp,
    updatedAt: timestamp,
  },
});
export const TransactionSchema = new EntitySchema({
  class: TransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id,
    providerId: text,
    externalTransactionId: text,
    idempotencyKey: text,
    payloadHash: text,
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: text,
    gameId: text,
    kind: text,
    amount: money,
    currency: text,
    status: text,
    referenceExternalTransactionId: { ...text, nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { ...text, nullable: true },
    resultBalance: { ...money, nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, nullable: true },
    correlationId: text,
    createdAt: timestamp,
    processedAt: { ...timestamp, nullable: true },
  },
});
export const LedgerSchema = new EntitySchema({
  class: LedgerRow,
  tableName: 'wallet_ledger',
  properties: {
    id,
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: text,
    amount: money,
    currency: text,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: { type: 'integer' },
    createdAt: timestamp,
  },
});
export const InboxSchema = new EntitySchema({
  class: InboxRow,
  tableName: 'inbox',
  properties: {
    id,
    consumerName: text,
    messageId: text,
    payloadHash: text,
    transactionId: { type: 'uuid' },
    receivedAt: timestamp,
    processedAt: timestamp,
  },
});
export const OutboxSchema = new EntitySchema({
  class: OutboxRow,
  tableName: 'outbox',
  properties: {
    traceContext: { type: 'json' },
    id,
    aggregateId: { type: 'uuid' },
    eventType: text,
    payload: { type: 'json' },
    occurredAt: timestamp,
    attempts: { type: 'integer' },
    nextAttemptAt: timestamp,
    publishedAt: { ...timestamp, nullable: true },
    leaseOwner: { ...text, nullable: true },
    leaseUntil: { ...timestamp, nullable: true },
  },
});
export const PostingSchema = new EntitySchema({
  class: PostingRow,
  tableName: 'journal_postings',
  properties: {
    id,
    ledgerId: { type: 'uuid' },
    account: text,
    side: text,
    amount: money,
    currency: text,
  },
});
export const entities = [
  WalletSchema,
  TransactionSchema,
  LedgerSchema,
  InboxSchema,
  OutboxSchema,
  PostingSchema,
];
