import { result } from '../../application/wagering';
import { DomainError } from '../../domain/errors';
import { Money } from '../../domain/money';
import { log, metrics } from '../observability';
import type { Database } from './database';
import { LedgerRow, PostingRow, TransactionRow, WalletRow } from './entities';
import { toTransaction } from './store';

export class Queries {
  constructor(private readonly db: Database) {}
  async wallet(id: string) {
    const row = await this.db.em.fork().findOne(WalletRow, id);
    if (!row) throw new DomainError('NOT_FOUND', 'Wallet not found');
    return {
      id: row.id,
      playerId: row.playerId,
      balance: { amount: row.balance, currency: row.currency },
      version: row.version,
    };
  }
  async transaction(id: string) {
    const row = await this.db.em.fork().findOne(TransactionRow, id);
    return this.transactionResponse(row);
  }
  async externalTransaction(providerId: string, externalTransactionId: string) {
    const row = await this.db.em
      .fork()
      .findOne(TransactionRow, { providerId, externalTransactionId });
    return this.transactionResponse(row);
  }
  private transactionResponse(row: TransactionRow | null) {
    if (!row) throw new DomainError('NOT_FOUND', 'Transaction not found');
    return {
      ...result(toTransaction(row), false),
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      money: { amount: row.amount, currency: row.currency },
      referenceExternalTransactionId: row.referenceExternalTransactionId,
      createdAt: row.createdAt.toISOString(),
      processedAt: row.processedAt?.toISOString() ?? null,
    };
  }
  async ledger(walletId: string, cursor: string | undefined, limit: number) {
    const wallet = await this.wallet(walletId);
    let after = 0;
    let ceiling = wallet.version;
    if (cursor) {
      try {
        if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor))
          throw new Error('Invalid encoding');
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !('walletId' in parsed) ||
          parsed.walletId !== walletId ||
          !('v' in parsed) ||
          parsed.v !== 1 ||
          !('after' in parsed) ||
          !('ceiling' in parsed) ||
          typeof parsed.after !== 'number' ||
          typeof parsed.ceiling !== 'number' ||
          !Number.isSafeInteger(parsed.after) ||
          !Number.isSafeInteger(parsed.ceiling) ||
          parsed.after < 0 ||
          parsed.ceiling < parsed.after ||
          parsed.ceiling > wallet.version
        )
          throw new Error('Invalid cursor');
        after = parsed.after;
        ceiling = parsed.ceiling;
      } catch {
        throw new DomainError('INVALID_INPUT', 'Invalid ledger cursor');
      }
    }
    const rows = await this.db.em
      .fork()
      .find(
        LedgerRow,
        { walletId, walletVersion: { $gt: after, $lte: ceiling } },
        { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
      );
    const page = rows.slice(0, limit);
    const postings = page.length
      ? await this.db.em.fork().find(PostingRow, { ledgerId: { $in: page.map((row) => row.id) } })
      : [];
    const last = page.at(-1);
    return {
      entries: page.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balanceBefore, currency: row.currency },
        balanceAfter: { amount: row.balanceAfter, currency: row.currency },
        walletVersion: row.walletVersion,
        createdAt: row.createdAt.toISOString(),
        postings: postings
          .filter((posting) => posting.ledgerId === row.id)
          .map((posting) => ({
            account: posting.account,
            side: posting.side,
            money: { amount: posting.amount, currency: posting.currency },
          })),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ v: 1, walletId, after: last.walletVersion, ceiling }),
            ).toString('base64url')
          : null,
    };
  }
  async reconcile(walletId: string, correlationId: string) {
    // A single PostgreSQL statement reads balance and ledger from the same MVCC snapshot.
    const [row] = await this.db.em.fork().execute<
      {
        currency: string;
        stored: string;
        calculated: string;
        count: string;
        postings: string;
        debits: string;
        credits: string;
      }[]
    >(
      `
      SELECT w.currency, w.balance::text AS stored,
      COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated,
      COUNT(l.id)::text AS count,
      (SELECT count(*)::text FROM journal_postings p JOIN wallet_ledger m ON m.id = p.ledger_id WHERE m.wallet_id = w.id) AS postings,
      (SELECT COALESCE(sum(p.amount),0.00)::text FROM journal_postings p JOIN wallet_ledger m ON m.id = p.ledger_id WHERE m.wallet_id = w.id AND p.side = 'DEBIT') AS debits,
      (SELECT COALESCE(sum(p.amount),0.00)::text FROM journal_postings p JOIN wallet_ledger m ON m.id = p.ledger_id WHERE m.wallet_id = w.id AND p.side = 'CREDIT') AS credits
      FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    if (!row) throw new DomainError('NOT_FOUND', 'Wallet not found');
    const stored = Money.rehydrate({ amount: row.stored, currency: row.currency });
    const calculated = Money.rehydrate({ amount: row.calculated, currency: row.currency });
    const journalConsistent =
      row.debits === row.credits && BigInt(row.postings) === 2n * BigInt(row.count);
    const consistent = stored.equals(calculated) && journalConsistent;
    if (!consistent) {
      metrics.reconciliation.inc();
      log('error', 'reconciliation_mismatch', { walletId, correlationId });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent,
      checkedEntries: Number(row.count),
      doubleEntry: {
        consistent: journalConsistent,
        checkedPostings: Number(row.postings),
        debits: { amount: row.debits, currency: row.currency },
        credits: { amount: row.credits, currency: row.currency },
      },
    };
  }
}
