import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { payloadHash } from '../../src/application/contracts';
import type { BrokerPort, FinancialStore } from '../../src/application/ports';
import { WageringService } from '../../src/application/wagering';
import { config } from '../../src/config';
import { connectDatabase, type Database } from '../../src/infrastructure/database/database';
import { PostgresFinancialStore } from '../../src/infrastructure/database/store';
import { SqsConsumer } from '../../src/infrastructure/messaging/consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { ReferenceWorker } from '../../src/infrastructure/messaging/reference-worker';
import { SqsBroker } from '../../src/infrastructure/messaging/sqs';

let db: Database;
let broker: SqsBroker;
let service: WageringService;
let consumer: SqsConsumer;
const ctx = { correlationId: 'messaging-test' };
async function open() {
  return service.openWallet(
    { playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } },
    ctx,
  );
}
function input(w: { id: string; playerId: string }, kind = 'BET') {
  return {
    providerId: `p-${crypto.randomUUID()}`,
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    playerId: w.playerId,
    walletId: w.id,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: { amount: '10.00', currency: 'BRL' },
  };
}
function envelope(data: ReturnType<typeof input> & { referenceExternalTransactionId?: string }) {
  return {
    messageId: `m-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}
async function send(value: ReturnType<typeof envelope> | string) {
  return broker.client.send(
    new SendMessageCommand({
      QueueUrl: await broker.url(broker.names.requests),
      MessageBody: typeof value === 'string' ? value : JSON.stringify(value),
      MessageGroupId: typeof value === 'string' ? 'invalid' : value.data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}
async function balance(walletId: string) {
  const [row] = await db.em
    .fork()
    .execute<{ balance: string; calculated: string; entries: string }[]>(
      `
    SELECT w.balance::text, COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0)::numeric(20,2)::text AS calculated,
    COUNT(l.id)::text AS entries FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
  expect(row?.balance).toBe(row?.calculated);
  return row;
}
async function messages(name: string) {
  const url = await broker.url(name);
  const response = await broker.client.send(
    new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
  );
  for (const message of response.Messages ?? []) {
    await broker.client.send(
      new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
    );
  }
  return response.Messages ?? [];
}
async function eventually(work: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    if (await work()) return;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Condition did not become true within the deadline');
}
beforeAll(async () => {
  db = await connectDatabase();
  broker = new SqsBroker();
  service = new WageringService(new PostgresFinancialStore(db));
  consumer = new SqsConsumer(broker, service);
});
afterAll(async () => {
  consumer?.stop();
  broker?.close();
  await db?.close(true);
});

describe('real SQS, PostgreSQL and recovery', () => {
  test('transport duplicates bypass FIFO dedup and are caught by the persistent inbox', async () => {
    const w = await open();
    const message = envelope(input(w));
    await send(message);
    await send(message);
    await send(message);
    let received = 0;
    await eventually(async () => {
      received += await consumer.tick(0);
      return received >= 3;
    });
    expect((await balance(w.id))?.balance).toBe('90.00');
    const [inbox] = await db.em
      .fork()
      .execute<{ count: string }[]>('select count(*)::text from inbox where message_id = ?', [
        message.messageId,
      ]);
    expect(inbox?.count).toBe('1');
    expect((await balance(w.id))?.entries).toBe('2');
  });
  test('business rejection is committed and acknowledged without DLQ', async () => {
    const w = await open();
    const data = input(w);
    data.money.amount = '200.00';
    await send(envelope(data));
    await consumer.tick(0);
    const [tx] = await db.em
      .fork()
      .execute<{ status: string; failure_code: string }[]>(
        'select status, failure_code from wager_transactions where idempotency_key = ?',
        [data.idempotencyKey],
      );
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect((await messages(broker.names.dlq)).length).toBe(0);
    expect((await balance(w.id))?.balance).toBe('100.00');
  });
  test('worker killed after commit is safely redelivered to a new consumer', async () => {
    const w = await open();
    const message = envelope(input(w));
    await send(message);
    const child = Bun.spawn([process.execPath, 'tests/fixtures/process.ts', 'crash-consumer'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LOG_LEVEL: 'silent' },
    });
    expect(await child.exited).not.toBe(0);
    expect((await balance(w.id))?.balance).toBe('90.00');
    const recovered = new SqsConsumer(broker, service);
    let received = false;
    await eventually(async () => {
      received = (await recovered.tick(0)) > 0;
      return received;
    }, 30000);
    expect(received).toBe(true);
    recovered.stop();
    expect((await balance(w.id))?.balance).toBe('90.00');
    expect((await balance(w.id))?.entries).toBe('2');
  });
  test('malformed permanent messages go to DLQ', async () => {
    await send('{invalid-json');
    await consumer.tick(0);
    const dlq = await messages(broker.names.dlq);
    expect(dlq.some((m) => m.Body === '{invalid-json')).toBe(true);
  });
  test('transient failures roll back and exhaust a bounded retry budget into DLQ', async () => {
    const w = await open();
    const message = envelope(input(w));
    const delegate = new PostgresFinancialStore(db);
    let attempts = 0;
    const store: FinancialStore = {
      atomic: (work) =>
        delegate.atomic(async (session) => {
          const value = await work(session);
          if (++attempts <= config.SQS_MAX_RECEIVES)
            throw new Error('injected-transient-before-commit');
          return value;
        }),
    };
    const failing = new SqsConsumer(broker, new WageringService(store));
    await send(message);
    await failing.tick(0);
    expect((await balance(w.id))?.balance).toBe('100.00');
    let found = false;
    await eventually(async () => {
      await failing.tick(0);
      const dlq = await messages(broker.names.dlq);
      found = dlq.some((m) => m.Body?.includes(message.messageId));
      return found;
    }, 20000);
    expect(found).toBe(true);
    failing.stop();
    const [failed] = await db.em
      .fork()
      .execute<{ status: string; failure_code: string }[]>(
        'select status, failure_code from wager_transactions where idempotency_key = ?',
        [message.data.idempotencyKey],
      );
    expect(failed).toMatchObject({ status: 'FAILED', failure_code: 'INFRASTRUCTURE_FAILURE' });
    expect((await balance(w.id))?.balance).toBe('100.00');
  });
  test('REFUND and ROLLBACK delivered before references are later applied exactly once', async () => {
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const w = await open();
      const original = input(w, kind === 'REFUND' ? 'BET' : 'WIN');
      const reversal = {
        ...original,
        kind,
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        referenceExternalTransactionId: original.externalTransactionId,
      };
      await send(envelope(reversal));
      await consumer.tick(0);
      expect((await balance(w.id))?.balance).toBe('100.00');
      await send(envelope(original));
      await consumer.tick(0);
      await db.em
        .fork()
        .execute(
          "update wager_transactions set next_attempt_at = now() - interval '1 second' where idempotency_key = ?",
          [reversal.idempotencyKey],
        );
      const a = new ReferenceWorker(db, service);
      const b = new ReferenceWorker(db, service);
      await Promise.all([a.tick(), b.tick()]);
      const [tx] = await db.em
        .fork()
        .execute<{ status: string }[]>(
          'select status from wager_transactions where idempotency_key = ?',
          [reversal.idempotencyKey],
        );
      expect(tx?.status).toBe('PROCESSED');
      expect((await balance(w.id))?.balance).toBe('100.00');
      expect((await balance(w.id))?.entries).toBe('3');
    }
  });
  test('missing references expire with an auditable rejection event', async () => {
    const w = await open();
    const data = { ...input(w, 'REFUND'), referenceExternalTransactionId: 'never-arrives' };
    const { idempotencyKey, ...body } = data;
    const accepted = await service.submit(body, idempotencyKey, ctx);
    expect(accepted.status).toBe('PENDING_REFERENCE');
    for (let i = 0; i < config.REFERENCE_MAX_ATTEMPTS; i++) {
      await db.em
        .fork()
        .execute(
          "update wager_transactions set next_attempt_at = now() - interval '1 second' where idempotency_key = ? and status = 'PENDING_REFERENCE'",
          [idempotencyKey],
        );
      await new ReferenceWorker(db, service).tick();
    }
    const [tx] = await db.em
      .fork()
      .execute<{ status: string; failure_code: string }[]>(
        'select status, failure_code from wager_transactions where idempotency_key = ?',
        [idempotencyKey],
      );
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_EXPIRED' });
    const [event] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        "select count(*)::text from outbox where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = ?",
        [accepted.transactionId],
      );
    expect(event?.count).toBe('1');
    expect((await balance(w.id))?.balance).toBe('100.00');
  });
  test('two outbox publishers claim disjoint work and publish real SQS events', async () => {
    const w = await open();
    const data = input(w);
    const { idempotencyKey, ...body } = data;
    const tx = await service.submit(body, idempotencyKey, ctx);
    const calls = new Map<string, number>();
    const observed: BrokerPort = {
      publish: async (id, aggregateId, payload) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        await broker.publish(id, aggregateId, payload);
      },
    };
    const a = new OutboxPublisher(db, observed);
    const b = new OutboxPublisher(db, observed);
    await eventually(async () => {
      await Promise.all([a.tick(), b.tick()]);
      const [count] = await db.em
        .fork()
        .execute<{ count: string }[]>(
          'select count(*)::text from outbox where published_at is null',
        );
      return count?.count === '0';
    }, 20000);
    const seen: Record<string, unknown>[] = [];
    await eventually(async () => {
      seen.push(
        ...(await messages(broker.names.events)).map(
          (m) => JSON.parse(m.Body ?? '{}') as Record<string, unknown>,
        ),
      );
      return ['WagerTransactionProcessed', 'WalletBalanceChanged'].every((type) =>
        seen.some(
          (e) =>
            e.eventType === type &&
            (e.data as { transactionId?: string })?.transactionId === tx.transactionId,
        ),
      );
    }, 20000);
    const relevant = seen.filter(
      (e) => (e.data as { transactionId?: string })?.transactionId === tx.transactionId,
    );
    expect(relevant.some((e) => e.eventType === 'WalletBalanceChanged')).toBe(true);
    expect(new Set(seen.map((e) => e.eventId)).size).toBe(seen.length);
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
  });
  test('publication before publisher failure retries with the same durable event ID', async () => {
    const w = await open();
    const sent = new Map<string, string[]>();
    const uncertain: BrokerPort = {
      publish: async (id, aggregateId, payload) => {
        if (aggregateId === w.id) sent.set(id, [...(sent.get(id) ?? []), payloadHash(payload)]);
        await broker.publish(id, aggregateId, payload);
        throw new Error('injected-after-sqs-publish-before-database-mark');
      },
    };
    await new OutboxPublisher(db, uncertain).tick();
    const [before] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        'select count(*)::text from outbox where aggregate_id = ? and published_at is null',
        [w.id],
      );
    expect(before?.count).toBe('2');
    await db.em
      .fork()
      .execute('update outbox set next_attempt_at = now() where aggregate_id = ?', [w.id]);
    const resumed: BrokerPort = {
      publish: async (id, aggregateId, payload) => {
        if (aggregateId === w.id) sent.set(id, [...(sent.get(id) ?? []), payloadHash(payload)]);
        await broker.publish(id, aggregateId, payload);
      },
    };
    await new OutboxPublisher(db, resumed).tick();
    expect(sent.size).toBe(2);
    for (const hashes of sent.values()) {
      expect(hashes).toHaveLength(2);
      expect(new Set(hashes).size).toBe(1);
    }
    const [after] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        'select count(*)::text from outbox where aggregate_id = ? and published_at is null',
        [w.id],
      );
    expect(after?.count).toBe('0');
    expect((await balance(w.id))?.balance).toBe('100.00');
  });
  test('outbox retries survive a publisher restart and expired leases are reclaimed', async () => {
    const w = await open();
    const failing: BrokerPort = {
      publish: async () => {
        throw new Error('injected-sqs-outage');
      },
    };
    const publisher = new OutboxPublisher(db, failing);
    await publisher.tick();
    const [row] = await db.em
      .fork()
      .execute<{ attempts: number; published_at: Date | null }[]>(
        'select attempts, published_at from outbox where aggregate_id = ? limit 1',
        [w.id],
      );
    expect(row?.attempts).toBe(1);
    expect(row?.published_at).toBeNull();
    await db.em
      .fork()
      .execute(
        "update outbox set next_attempt_at = now(), lease_owner = 'dead-publisher', lease_until = now() - interval '1 second' where aggregate_id = ?",
        [w.id],
      );
    await new OutboxPublisher(db, broker).tick();
    const [unpublished] = await db.em
      .fork()
      .execute<{ count: string }[]>(
        'select count(*)::text from outbox where aggregate_id = ? and published_at is null',
        [w.id],
      );
    expect(unpublished?.count).toBe('0');
    expect((await balance(w.id))?.balance).toBe('100.00');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });
});
