import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { FinancialSession, FinancialStore, TransactionRecord } from '../../application/ports';
import type { IntegrationEvent } from '../../domain/events';
import type { WalletLedgerEntry } from '../../domain/ledger';
import { InboxMessage, OutboxMessage } from '../../domain/messages';
import { Money } from '../../domain/money';
import { WagerTransaction } from '../../domain/transaction';
import { Wallet } from '../../domain/wallet';
import { errorCode, metrics } from '../observability';
import type { Database } from './database';
import { InboxRow, LedgerRow, OutboxRow, TransactionRow, WalletRow } from './entities';

export function toTransaction(row: TransactionRow): TransactionRecord {
  return {
    transaction: WagerTransaction.rehydrate({
      ...row,
      money: Money.rehydrate({ amount: row.amount, currency: row.currency }),
      referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
      failureCode: row.failureCode ?? undefined,
      processedAt: row.processedAt ?? undefined,
    }),
    resultBalance:
      row.resultBalance === null
        ? null
        : Money.rehydrate({ amount: row.resultBalance, currency: row.currency }),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    correlationId: row.correlationId,
  };
}
export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    ...row,
    balance: Money.rehydrate({ amount: row.balance, currency: row.currency }),
  });
}

class Session implements FinancialSession {
  constructor(private readonly em: EntityManager) {}
  async lockKeys(keys: string[]): Promise<void> {
    for (const key of [...new Set(keys)].sort()) {
      await this.em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
    }
  }
  async wallet(id: string, lock = false) {
    const row = await this.em.findOne(
      WalletRow,
      { id },
      lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {},
    );
    return row ? toWallet(row) : null;
  }
  insertWallet(wallet: Wallet): void {
    this.em.persist(
      this.em.create(WalletRow, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toString(),
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
  }
  async saveWallet(wallet: Wallet): Promise<void> {
    const row = await this.em.findOneOrFail(WalletRow, wallet.id);
    row.balance = wallet.balance.toString();
    row.version = wallet.version;
    row.updatedAt = wallet.updatedAt;
  }
  async transactionByKey(key: string) {
    const row = await this.em.findOne(TransactionRow, { idempotencyKey: key }, { refresh: true });
    return row ? toTransaction(row) : null;
  }
  async transactionByExternal(provider: string, externalId: string) {
    const row = await this.em.findOne(TransactionRow, {
      providerId: provider,
      externalTransactionId: externalId,
    });
    return row ? toTransaction(row) : null;
  }
  async saveTransaction(record: TransactionRecord): Promise<void> {
    const t = record.transaction;
    const data = {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toString(),
      currency: t.money.currency,
      status: t.status,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      failureCode: t.failureCode ?? null,
      resultBalance: record.resultBalance?.toString() ?? null,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      correlationId: record.correlationId,
      createdAt: t.createdAt,
      processedAt: t.processedAt ?? null,
    };
    const row = await this.em.findOne(TransactionRow, t.id);
    if (row) this.em.assign(row, data);
    else this.em.persist(this.em.create(TransactionRow, data));
  }
  async wasReversed(referenceId: string, kind: string): Promise<boolean> {
    return (
      (await this.em.count(TransactionRow, {
        referenceTransactionId: referenceId,
        kind: kind as 'REFUND' | 'ROLLBACK',
        status: 'PROCESSED',
      })) > 0
    );
  }
  insertLedger(entry: WalletLedgerEntry): void {
    this.em.persist(
      this.em.create(LedgerRow, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toString(),
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt,
      }),
    );
  }
  enqueue(event: IntegrationEvent<unknown>): void {
    const message = OutboxMessage.enqueue(event);
    this.em.persist(
      this.em.create(OutboxRow, {
        id: event.eventId,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.toJSON(),
        occurredAt: event.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: null,
        leaseOwner: null,
        leaseUntil: null,
      }),
    );
  }
  async inbox(consumerName: string, messageId: string) {
    return this.em.findOne(InboxRow, { consumerName, messageId });
  }
  completeInbox(
    consumerName: string,
    messageId: string,
    hash: string,
    transactionId: string,
  ): void {
    const now = new Date();
    const message = InboxMessage.receive({
      consumerName,
      messageId,
      payloadHash: hash,
      receivedAt: now,
    });
    message.markProcessed(now);
    this.em.persist(
      this.em.create(InboxRow, {
        id: crypto.randomUUID(),
        consumerName,
        messageId,
        payloadHash: hash,
        transactionId,
        receivedAt: now,
        processedAt: message.processedAt ?? now,
      }),
    );
  }
}

export class PostgresFinancialStore implements FinancialStore {
  constructor(private readonly db: Database) {}
  async atomic<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.em.fork().transactional((em) => work(new Session(em)));
      } catch (error) {
        if (!['40P01', '40001', '55P03'].includes(errorCode(error)) || attempt >= 2) throw error;
        metrics.lockConflicts.inc();
        await Bun.sleep(20 * 2 ** attempt + Math.floor(Math.random() * 20));
      }
    }
  }
}
