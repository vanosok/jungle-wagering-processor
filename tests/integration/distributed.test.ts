import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDatabase, type Database } from '../../src/infrastructure/database/database';

interface Child {
  process: ReturnType<typeof Bun.spawn>;
  port: number;
}
const children: Child[] = [];
let db: Database;
async function start(): Promise<Child> {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/process.ts', 'api'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });
  const reader = child.stdout.getReader();
  let output = '';
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, deadline - performance.now()));
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!next) break;
    if (next.done) throw new Error(`Child exited: ${await new Response(child.stderr).text()}`);
    output += new TextDecoder().decode(next.value);
    const match = output.match(/READY:(\d+)/);
    if (match?.[1]) {
      reader.releaseLock();
      const result = { process: child, port: Number(match[1]) };
      children.push(result);
      return result;
    }
  }
  child.kill();
  throw new Error('Child startup timed out');
}
async function request(port: number, path: string, body?: unknown, key?: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function open() {
  const response = await request(children[0]?.port ?? 0, '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; playerId: string };
}
function data(wallet: { id: string; playerId: string }, amount = '1.00') {
  return {
    providerId: 'distributed',
    externalTransactionId: crypto.randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    gameId: 'game',
    roundId: 'round',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}
beforeAll(async () => {
  db = await connectDatabase();
  await Promise.all([start(), start(), start()]);
});
afterAll(async () => {
  for (const child of children) child.process.kill();
  await Promise.all(children.map((child) => child.process.exited));
  await db?.close(true);
});

describe('three independent Bun/NestJS processes', () => {
  test('50 duplicates spread over three processes debit exactly once', async () => {
    const w = await open();
    const input = data(w);
    const key = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(children[index % 3]?.port ?? 0, '/wagering/transactions', input, key),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const outcomes = await Promise.all(
      responses.map(
        async (r) => (await r.json()) as { transactionId: string; idempotentReplay: boolean },
      ),
    );
    expect(new Set(outcomes.map((o) => o.transactionId)).size).toBe(1);
    expect(outcomes.filter((o) => !o.idempotentReplay)).toHaveLength(1);
    const reconciliation = await request(
      children[1]?.port ?? 0,
      `/wallets/${w.id}/reconciliation`,
      {},
    );
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '99.00' },
    });
  });
  test('80.00 competitors cannot overspend; independent wallets progress concurrently', async () => {
    const w = await open();
    const responses = await Promise.all(
      children
        .slice(0, 2)
        .map((child) =>
          request(child.port, '/wagering/transactions', data(w, '80.00'), crypto.randomUUID()),
        ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    const others = await Promise.all(Array.from({ length: 6 }, () => open()));
    const outcomes = await Promise.all(
      others.map((wallet, index) =>
        request(
          children[index % 3]?.port ?? 0,
          '/wagering/transactions',
          data(wallet),
          crypto.randomUUID(),
        ),
      ),
    );
    expect(outcomes.every((r) => r.status === 200)).toBe(true);
    const [mismatches] = await db.em
      .fork()
      .execute<{ count: string }[]>(`SELECT count(*)::text FROM wallets w WHERE
      w.balance <> (SELECT COALESCE(sum(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0) FROM wallet_ledger l WHERE l.wallet_id = w.id)`);
    expect(mismatches?.count).toBe('0');
  });
  test('restart preserves the original idempotent response and ledger', async () => {
    const w = await open();
    const input = data(w);
    const key = crypto.randomUUID();
    const original = (await (
      await request(children[0]?.port ?? 0, '/wagering/transactions', input, key)
    ).json()) as Record<string, unknown>;
    const old = children[0];
    old?.process.kill();
    await old?.process.exited;
    const restarted = await start();
    const replay = await request(restarted.port, '/wagering/transactions', input, key);
    expect(await replay.json()).toMatchObject({ ...original, idempotentReplay: true });
    const checked = await request(restarted.port, `/wallets/${w.id}/reconciliation`, {});
    expect(await checked.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '99.00' },
    });
  });
});
