import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { payloadHash } from '../../src/application/contracts';
import type { FinancialStore } from '../../src/application/ports';
import { WageringService } from '../../src/application/wagering';
import { connectDatabase, type Database } from '../../src/infrastructure/database/database';
import { PostgresFinancialStore } from '../../src/infrastructure/database/store';

let db: Database;
let service: WageringService;
const ctx = { correlationId: 'integration-financial' };
const money = (amount: string) => ({ amount, currency: 'BRL' });
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}
async function wallet(amount = '100.00') {
  return service.openWallet({ playerId: crypto.randomUUID(), initialBalance: money(amount) }, ctx);
}
function bet(w: { id: string; playerId: string }, amount = '10.00') {
  return {
    providerId: `p-${crypto.randomUUID()}`,
    externalTransactionId: crypto.randomUUID(),
    walletId: w.id,
    playerId: w.playerId,
    gameId: 'game',
    roundId: 'round',
    kind: 'BET',
    money: money(amount),
  };
}
async function consistent(id: string) {
  const [row] = await db.em.fork().execute<{ balance: string; calculated: string }[]>(
    `SELECT w.balance::text,
    COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated
    FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`,
    [id],
  );
  expect(row?.balance).toBe(row?.calculated);
  return row?.balance;
}

beforeAll(async () => {
  db = await connectDatabase();
  await db.migrator.up();
  service = new WageringService(new PostgresFinancialStore(db));
});
afterAll(async () => {
  await db?.close(true);
});

describe('PostgreSQL financial guarantees', () => {
  test('opening is fully audited, zero opening is not a movement', async () => {
    const w = await wallet();
    expect(await consistent(w.id)).toBe('100.00');
    const [row] = await db.em
      .fork()
      .execute<{ count: string }[]>('select count(*) from wallet_ledger where wallet_id = ?', [
        w.id,
      ]);
    expect(row?.count).toBe('1');
    const zero = await wallet('0.00');
    expect(await consistent(zero.id)).toBe('0.00');
  });
  test('50 parallel submissions produce one debit and stable replay snapshots', async () => {
    const w = await wallet();
    const data = bet(w);
    const key = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.submit(data, key, ctx)),
    );
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(await consistent(w.id)).toBe('90.00');
    await service.submit(bet(w), crypto.randomUUID(), ctx);
    expect((await service.submit(data, key, ctx)).balance?.amount).toBe('90.00');
    expect(await consistent(w.id)).toBe('80.00');
  });
  test('two 80.00 bets compete for 100.00', async () => {
    const w = await wallet();
    const results = await Promise.all([
      service.submit(bet(w, '80.00'), crypto.randomUUID(), ctx),
      service.submit(bet(w, '80.00'), crypto.randomUUID(), ctx),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await consistent(w.id)).toBe('20.00');
    const [count] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        "select count(*) from wallet_ledger where wallet_id = ? and direction = 'DEBIT'",
        [w.id],
      );
    expect(count?.count).toBe('1');
  });
  test('idempotency divergence and external identity conflicts are rejected', async () => {
    const w = await wallet();
    const data = bet(w);
    const key = crypto.randomUUID();
    await service.submit(data, key, ctx);
    expect(
      await rejected(service.submit({ ...data, money: money('11.00') }, key, ctx)),
    ).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await rejected(service.submit(data, crypto.randomUUID(), ctx))).toMatchObject({
      code: 'EXTERNAL_ID_CONFLICT',
    });
    expect(payloadHash({ b: 2, a: { c: 1 } })).toBe(payloadHash({ a: { c: 1 }, b: 2 }));
    expect(await consistent(w.id)).toBe('90.00');
  });
  test('LOSS has no ledger or version change; currency and player conflicts are audited', async () => {
    const w = await wallet();
    const loss = await service.submit(
      { ...bet(w), kind: 'LOSS', money: money('0.00') },
      crypto.randomUUID(),
      ctx,
    );
    expect(loss.status).toBe('PROCESSED');
    const currency = await service.submit(
      { ...bet(w), money: { amount: '1.00', currency: 'USD' } },
      crypto.randomUUID(),
      ctx,
    );
    expect(currency.failureCode).toBe('CURRENCY_MISMATCH');
    expect(currency.balance).toBeNull();
    const player = await service.submit(
      { ...bet(w), playerId: crypto.randomUUID() },
      crypto.randomUUID(),
      ctx,
    );
    expect(player.failureCode).toBe('PLAYER_MISMATCH');
    const [row] = await db.em
      .fork()
      .execute<{ version: number }[]>('select version from wallets where id = ?', [w.id]);
    expect(row?.version).toBe(1);
    expect(await consistent(w.id)).toBe('100.00');
  });
  test('refunds are full, reference-scoped, and unique per kind', async () => {
    const w = await wallet();
    const original = bet(w, '25.00');
    await service.submit(original, crypto.randomUUID(), ctx);
    const refund = {
      ...original,
      externalTransactionId: crypto.randomUUID(),
      kind: 'REFUND',
      referenceExternalTransactionId: original.externalTransactionId,
    };
    const partial = await service.submit(
      { ...refund, externalTransactionId: crypto.randomUUID(), money: money('20.00') },
      crypto.randomUUID(),
      ctx,
    );
    expect(partial.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.submit(
          { ...refund, externalTransactionId: crypto.randomUUID() },
          crypto.randomUUID(),
          ctx,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(4);
    expect(await consistent(w.id)).toBe('100.00');
  });
  test('rollback of WIN cannot overdraw a wallet', async () => {
    const w = await wallet('0.00');
    const win = { ...bet(w), kind: 'WIN' };
    await service.submit(win, crypto.randomUUID(), ctx);
    await service.submit(bet(w), crypto.randomUUID(), ctx);
    const rollback = await service.submit(
      {
        ...win,
        kind: 'ROLLBACK',
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId: win.externalTransactionId,
      },
      crypto.randomUUID(),
      ctx,
    );
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await consistent(w.id)).toBe('0.00');
  });
  test('inbox and financial idempotency share one commit', async () => {
    const w = await wallet();
    const data = bet(w);
    const key = crypto.randomUUID();
    const inbox = {
      consumerName: 'test',
      messageId: crypto.randomUUID(),
      payloadHash: payloadHash(data),
    };
    const first = await service.submit(data, key, { ...ctx, inbox });
    const replay = await service.submit(data, key, { ...ctx, inbox });
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(
      await rejected(
        service.submit(data, key, { ...ctx, inbox: { ...inbox, payloadHash: 'changed' } }),
      ),
    ).toMatchObject({ code: 'INBOX_CONFLICT' });
    expect(await consistent(w.id)).toBe('90.00');
  });
  test('an injected exception rolls back wallet, ledger, inbox and outbox', async () => {
    const w = await wallet();
    const data = bet(w);
    const key = crypto.randomUUID();
    const delegate = new PostgresFinancialStore(db);
    const crashingStore: FinancialStore = {
      atomic: (work) =>
        delegate.atomic(async (session) => {
          const value = await work(session);
          void value;
          throw new Error('injected-before-commit');
        }),
    };
    const crashing = new WageringService(crashingStore);
    expect(
      await rejected(
        crashing.submit(data, key, {
          ...ctx,
          inbox: { consumerName: 'crash', messageId: crypto.randomUUID(), payloadHash: 'hash' },
        }),
      ),
    ).toMatchObject({ message: 'injected-before-commit' });
    const [row] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        'select count(*) from wager_transactions where idempotency_key = ?',
        [key],
      );
    expect(row?.count).toBe('0');
    expect(await consistent(w.id)).toBe('100.00');
  });
  test('schema rejects direct negative balances, ledger edits and unpaired financial writes', async () => {
    const w = await wallet();
    expect(
      await rejected(
        db.em
          .fork()
          .execute('update wallets set balance = -1, version = version + 1 where id = ?', [w.id]),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await rejected(
        db.em
          .fork()
          .execute('update wallets set balance = 999, version = version + 1 where id = ?', [w.id]),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await rejected(
        db.em.fork().execute('update wallet_ledger set amount = 1 where wallet_id = ?', [w.id]),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await rejected(db.em.fork().execute('delete from wallet_ledger where wallet_id = ?', [w.id])),
    ).toBeInstanceOf(Error);
    expect(
      await rejected(
        db.em
          .fork()
          .execute("update wager_transactions set status = 'PENDING' where wallet_id = ?", [w.id]),
      ),
    ).toBeInstanceOf(Error);
    expect(
      await rejected(
        service.openWallet({ playerId: w.playerId, initialBalance: money('1.00') }, ctx),
      ),
    ).toBeInstanceOf(Error);
    expect(await consistent(w.id)).toBe('100.00');
  });
});
