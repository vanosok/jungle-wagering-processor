import { config } from '../config';
import { DomainError } from '../domain/errors';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { WalletLedgerEntry } from '../domain/ledger';
import { Money, type MoneyProps } from '../domain/money';
import { type TransactionStatus, WagerTransaction } from '../domain/transaction';
import { Wallet } from '../domain/wallet';
import { keySchema, parseTransaction, payloadHash, walletSchema } from './contracts';
import type { FinancialSession, FinancialStore, RequestContext, TransactionRecord } from './ports';

export interface TransactionResult {
  transactionId: string;
  status: TransactionStatus;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: string;
}
export function result(record: TransactionRecord, replay: boolean): TransactionResult {
  return {
    transactionId: record.transaction.id,
    status: record.transaction.status,
    balance: record.resultBalance?.toJSON() ?? null,
    idempotentReplay: replay,
    ...(record.transaction.failureCode ? { failureCode: record.transaction.failureCode } : {}),
  };
}

export class WageringService {
  constructor(private readonly store: FinancialStore) {}

  async openWallet(input: unknown, ctx: RequestContext) {
    const parsed = walletSchema.safeParse(input);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Invalid wallet contract');
    const money = Money.from(parsed.data.initialBalance);
    return this.store.atomic(async (session) => {
      await session.lockKeys([`wallet-open:${parsed.data.playerId}:${money.currency}`]);
      const wallet = Wallet.open({
        id: crypto.randomUUID(),
        playerId: parsed.data.playerId,
        initialBalance: money,
      });
      session.insertWallet(wallet);
      if (money.isPositive()) {
        const transaction = WagerTransaction.create({
          id: crypto.randomUUID(),
          providerId: 'internal:opening',
          externalTransactionId: wallet.id,
          idempotencyKey: `internal:opening:${wallet.id}`,
          payloadHash: payloadHash({ walletId: wallet.id, money: money.toJSON() }),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: 'OPENING',
          money,
          createdAt: wallet.createdAt,
        });
        transaction.markProcessed(undefined, new Date());
        const entry = WalletLedgerEntry.create({
          id: crypto.randomUUID(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: 'CREDIT',
          money,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: money,
          walletVersion: 1,
          createdAt: wallet.createdAt,
        });
        await session.saveTransaction({
          transaction,
          resultBalance: money,
          attempts: 0,
          nextAttemptAt: null,
          correlationId: ctx.correlationId,
        });
        session.insertLedger(entry);
        session.enqueue(WagerTransactionProcessed.from(transaction, ctx));
        session.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
      }
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  async submit(input: unknown, key: string, ctx: RequestContext): Promise<TransactionResult> {
    return this.accept(input, key, ctx, false);
  }

  async recordPermanentFailure(
    input: unknown,
    key: string,
    ctx: RequestContext,
  ): Promise<TransactionResult> {
    return this.accept(input, key, ctx, true);
  }

  private async accept(
    input: unknown,
    key: string,
    ctx: RequestContext,
    permanentFailure: boolean,
  ): Promise<TransactionResult> {
    const data = parseTransaction(input);
    if (!keySchema.safeParse(key).success)
      throw new DomainError('INVALID_INPUT', 'Valid Idempotency-Key required');
    const hash = payloadHash(data);
    return this.store.atomic(async (session) => {
      if (ctx.inbox)
        await session.lockKeys([`inbox:${ctx.inbox.consumerName}:${ctx.inbox.messageId}`]);
      await session.lockKeys([
        `key:${key}`,
        `external:${data.providerId}:${data.externalTransactionId}`,
      ]);
      const existing = await session.transactionByKey(key);
      if (existing && !existing.transaction.matchesPayload(hash)) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key has another business payload',
        );
      }
      if (ctx.inbox) {
        const inbox = await session.inbox(ctx.inbox.consumerName, ctx.inbox.messageId);
        if (inbox) {
          if (
            inbox.payloadHash !== ctx.inbox.payloadHash ||
            !existing ||
            inbox.transactionId !== existing.transaction.id
          ) {
            throw new DomainError('INBOX_CONFLICT', 'Message ID was reused with different content');
          }
          return result(existing, true);
        }
      }
      if (existing) {
        this.completeInbox(session, ctx, existing.transaction.id);
        return result(existing, true);
      }
      const external = await session.transactionByExternal(
        data.providerId,
        data.externalTransactionId,
      );
      if (external)
        throw new DomainError(
          'EXTERNAL_ID_CONFLICT',
          'External transaction already has another idempotency key',
        );
      const transaction = WagerTransaction.create({
        ...data,
        id: crypto.randomUUID(),
        idempotencyKey: key,
        payloadHash: hash,
        money: Money.from(data.money),
        createdAt: new Date(),
      });
      const record: TransactionRecord = {
        transaction,
        resultBalance: null,
        attempts: 0,
        nextAttemptAt: null,
        correlationId: ctx.correlationId,
      };
      if (permanentFailure) {
        const wallet = await session.wallet(transaction.walletId, true);
        if (
          wallet &&
          wallet.currency === transaction.money.currency &&
          wallet.playerId === transaction.playerId
        ) {
          record.resultBalance = wallet.balance;
        }
        transaction.fail('INFRASTRUCTURE_FAILURE');
        await session.saveTransaction(record);
        session.enqueue(WagerTransactionFailed.from(transaction, ctx));
      } else await this.apply(session, record, ctx);
      this.completeInbox(session, ctx, transaction.id);
      return result(record, false);
    });
  }

  async retryReference(provider: string, externalId: string): Promise<boolean> {
    return this.store.atomic(async (session) => {
      // The first lookup obtains immutable identity only; reload after acquiring the same locks as HTTP.
      const initial = await session.transactionByExternal(provider, externalId);
      if (!initial) return false;
      await session.lockKeys([
        `key:${initial.transaction.idempotencyKey}`,
        `external:${provider}:${externalId}`,
      ]);
      const record = await session.transactionByKey(initial.transaction.idempotencyKey);
      if (
        !record ||
        record.transaction.status !== 'PENDING_REFERENCE' ||
        (record.nextAttemptAt && record.nextAttemptAt > (await session.now()))
      )
        return false;
      record.attempts += 1;
      await this.apply(session, record, {
        correlationId: record.correlationId,
        causationId: record.transaction.id,
      });
      return true;
    });
  }

  private async apply(
    session: FinancialSession,
    record: TransactionRecord,
    ctx: RequestContext,
  ): Promise<void> {
    const transaction = record.transaction;
    const wallet = await session.wallet(transaction.walletId, true);
    const wasPending = transaction.status === 'PENDING_REFERENCE';
    let ledgerEntry: WalletLedgerEntry | undefined;
    try {
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet does not exist');
      // Never return a snapshot denominated in a different currency.
      if (wallet.currency !== transaction.money.currency)
        throw new DomainError('CURRENCY_MISMATCH', 'Wallet currency differs');
      record.resultBalance = wallet.balance;
      if (wallet.playerId !== transaction.playerId)
        throw new DomainError('PLAYER_MISMATCH', 'Player does not own wallet');
      let reference: WagerTransaction | undefined;
      if (transaction.referenceExternalTransactionId) {
        const referenced = await session.transactionByExternal(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );
        reference = referenced?.transaction;
        // Validate identity before deciding whether a reference is merely not ready.
        if (
          reference &&
          (reference.walletId !== transaction.walletId ||
            reference.playerId !== transaction.playerId ||
            reference.roundId !== transaction.roundId ||
            reference.money.currency !== transaction.money.currency)
        ) {
          throw new DomainError('INVALID_REFERENCE', 'Reference context differs');
        }
        if (!reference || !reference.isTerminal()) {
          if (record.attempts >= config.REFERENCE_MAX_ATTEMPTS) {
            throw new DomainError(
              'REFERENCE_EXPIRED',
              'Reference was not available within retry budget',
            );
          }
          transaction.markPendingReference();
          record.nextAttemptAt = new Date(
            (await session.now()).getTime() +
              Math.min(
                config.REFERENCE_MAX_DELAY_MS,
                config.REFERENCE_BASE_DELAY_MS * 2 ** Math.min(record.attempts, 20),
              ),
          );
          if (!wasPending) session.enqueue(WagerTransactionPendingReference.from(transaction, ctx));
          await session.saveTransaction(record);
          return;
        }
        transaction.validateReference(reference);
        if (
          transaction.requiresReference() &&
          (await session.wasReversed(reference.id, transaction.kind))
        ) {
          throw new DomainError(
            'ALREADY_REVERSED',
            'Reference already reversed by this operation kind',
          );
        }
      }
      if (transaction.affectsBalance()) {
        const direction = transaction.ledgerDirectionFor(reference);
        const entry =
          direction === 'CREDIT'
            ? wallet.credit(transaction.money, transaction.id)
            : wallet.debit(transaction.money, transaction.id, transaction.kind === 'ROLLBACK');
        ledgerEntry = entry;
        await session.saveWallet(wallet);
        session.enqueue(WalletBalanceChanged.from(wallet, entry, ctx));
      }
      transaction.markProcessed(reference?.id, new Date());
      record.resultBalance = wallet.balance;
      record.nextAttemptAt = null;
      session.enqueue(WagerTransactionProcessed.from(transaction, ctx));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      transaction.reject(error.code);
      record.nextAttemptAt = null;
      session.enqueue(WagerTransactionRejected.from(transaction, ctx));
    }
    await session.saveTransaction(record);
    if (ledgerEntry) session.insertLedger(ledgerEntry);
  }

  private completeInbox(
    session: FinancialSession,
    ctx: RequestContext,
    transactionId: string,
  ): void {
    if (ctx.inbox)
      session.completeInbox(
        ctx.inbox.consumerName,
        ctx.inbox.messageId,
        ctx.inbox.payloadHash,
        transactionId,
      );
  }
}
