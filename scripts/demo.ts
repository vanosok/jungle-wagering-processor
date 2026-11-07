import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsBroker } from '../src/infrastructure/messaging/sqs';

const base = process.env.API_URL ?? 'http://localhost:3000';
async function call(path: string, body?: unknown, key?: string) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Demo HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const w = (await call('/wallets', {
  playerId: crypto.randomUUID(),
  initialBalance: { amount: '100.00', currency: 'BRL' },
})) as { id: string; playerId: string };
console.log('Created wallet:', w);
const transaction = {
  providerId: 'demo',
  externalTransactionId: crypto.randomUUID(),
  playerId: w.playerId,
  walletId: w.id,
  roundId: `round-${crypto.randomUUID()}`,
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const key = `demo:${transaction.externalTransactionId}`;
console.log('Bet:', await call('/wagering/transactions', transaction, key));
console.log(
  'Replay (same historical balance):',
  await call('/wagering/transactions', transaction, key),
);
const broker = new SqsBroker();
try {
  const externalId = crypto.randomUUID();
  await broker.client.send(
    new SendMessageCommand({
      QueueUrl: await broker.url(broker.names.requests),
      MessageGroupId: w.id,
      MessageDeduplicationId: externalId,
      MessageBody: JSON.stringify({
        messageId: `demo-${externalId}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...transaction,
          externalTransactionId: externalId,
          idempotencyKey: `demo:${externalId}`,
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
    }),
  );
  let applied = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/providers/demo/wagering/transactions/${externalId}`);
    if (response.ok) {
      const outcome = (await response.json()) as { status: string };
      if (outcome.status === 'PROCESSED') {
        console.log('SQS win:', outcome);
        applied = true;
        break;
      }
    }
    await Bun.sleep(200);
  }
  if (!applied) throw new Error('SQS transaction did not complete within 20 seconds');
  console.log('Reconciliation:', await call(`/wallets/${w.id}/reconciliation`, {}));
  console.log('Ledger:', await call(`/wallets/${w.id}/ledger`));
} finally {
  broker.close();
}
