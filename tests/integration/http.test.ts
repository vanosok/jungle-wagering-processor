import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SqsBroker } from '../../src/infrastructure/messaging/sqs';
import { bootstrap } from '../../src/main';

let instance: Awaited<ReturnType<typeof bootstrap>>;
let base: string;
const headers = { 'content-type': 'application/json' };
async function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  instance = await bootstrap(0, false);
  base = `http://127.0.0.1:${instance.port}`;
});
afterAll(async () => {
  await instance?.close();
});

describe('NestJS HTTP contract', () => {
  test('liveness, readiness and metrics are available', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('wager_processing_seconds');
  });
  test('missing SQS resources fail readiness while liveness remains healthy', async () => {
    const original = instance.runtime.broker;
    const missing = new SqsBroker(`missing-${crypto.randomUUID().slice(0, 8)}-`);
    instance.runtime.broker = missing;
    try {
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
    } finally {
      instance.runtime.broker = original;
      missing.close();
    }
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });
  test('HTTP distinguishes validation, conflict, business rejection, pending and success', async () => {
    const playerId = crypto.randomUUID();
    const opened = await post('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(opened.status).toBe(201);
    const wallet = (await opened.json()) as { id: string; playerId: string };
    expect(
      (await post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }))
        .status,
    ).toBe(409);
    const data = {
      providerId: 'http-test',
      externalTransactionId: crypto.randomUUID(),
      walletId: wallet.id,
      playerId,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    expect((await post('/wagering/transactions', data)).status).toBe(400);
    const key = crypto.randomUUID();
    const identity = { 'idempotency-key': key };
    const first = await post('/wagering/transactions', data, identity);
    expect(first.status).toBe(200);
    const original = (await first.json()) as { transactionId: string; balance: unknown };
    const replay = await post('/wagering/transactions', data, identity);
    expect(await replay.json()).toMatchObject({ ...original, idempotentReplay: true });
    expect(
      (
        await post(
          '/wagering/transactions',
          { ...data, money: { amount: '1.00', currency: 'BRL' } },
          identity,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          '/wagering/transactions',
          { ...data, externalTransactionId: crypto.randomUUID() },
          { 'idempotency-key': crypto.randomUUID() },
        )
      ).status,
    ).toBe(422);
    const pending = await post(
      '/wagering/transactions',
      {
        ...data,
        kind: 'REFUND',
        externalTransactionId: crypto.randomUUID(),
        referenceExternalTransactionId: 'not-arrived',
      },
      { 'idempotency-key': crypto.randomUUID() },
    );
    expect(pending.status).toBe(202);
    expect((await fetch(`${base}/wagering/transactions/${original.transactionId}`)).status).toBe(
      200,
    );
    expect(
      (
        await fetch(
          `${base}/providers/http-test/wagering/transactions/${data.externalTransactionId}`,
        )
      ).status,
    ).toBe(200);
    const reconciliation = await post(`/wallets/${wallet.id}/reconciliation`, {});
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '20.00', currency: 'BRL' },
    });
    expect((await fetch(`${base}/wallets/not-a-uuid`)).status).toBe(400);
    expect((await fetch(`${base}/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect(
      (await post('/wagering/transactions', { ...data, kind: 'OPENING' }, identity)).status,
    ).toBe(400);
  });
  test('ledger cursor is stable while new entries arrive', async () => {
    const response = await post('/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const wallet = (await response.json()) as { id: string; playerId: string };
    const data = {
      providerId: 'pagination',
      externalTransactionId: crypto.randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      gameId: 'g',
      roundId: 'r',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
    await post('/wagering/transactions', data, { 'idempotency-key': crypto.randomUUID() });
    const first = (await (await fetch(`${base}/wallets/${wallet.id}/ledger?limit=1`)).json()) as {
      entries: { walletVersion: number }[];
      nextCursor: string;
    };
    expect(first.entries[0]?.walletVersion).toBe(1);
    expect(first.nextCursor).toBeString();
    await post(
      '/wagering/transactions',
      { ...data, externalTransactionId: crypto.randomUUID() },
      { 'idempotency-key': crypto.randomUUID() },
    );
    const second = (await (
      await fetch(`${base}/wallets/${wallet.id}/ledger?limit=1&cursor=${first.nextCursor}`)
    ).json()) as { entries: { walletVersion: number }[]; nextCursor: string | null };
    expect(second.entries[0]?.walletVersion).toBe(2);
    expect(second.nextCursor).toBeNull();
    expect((await fetch(`${base}/wallets/${wallet.id}/ledger?cursor=invalid`)).status).toBe(400);
    expect((await fetch(`${base}/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
  });
});
