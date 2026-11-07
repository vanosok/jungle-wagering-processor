import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsBroker } from '../src/infrastructure/messaging/sqs';

const base = process.env.API_URL ?? 'http://localhost:3000';
const traceId = crypto.randomUUID().replaceAll('-', '');
const traceparent = `00-${traceId}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}-01`;
const response = await fetch(`${base}/wallets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', traceparent },
  body: JSON.stringify({
    playerId: crypto.randomUUID(),
    initialBalance: { amount: '100.00', currency: 'BRL' },
  }),
});
if (response.status !== 201) throw new Error(`Wallet creation: HTTP ${response.status}`);
const wallet = (await response.json()) as { id: string; playerId: string };
const broker = new SqsBroker();
const external = crypto.randomUUID();
try {
  await broker.client.send(
    new SendMessageCommand({
      QueueUrl: await broker.url(broker.names.requests),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: external,
      MessageAttributes: { traceparent: { DataType: 'String', StringValue: traceparent } },
      MessageBody: JSON.stringify({
        messageId: `tracing-${external}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'tracing-check',
          externalTransactionId: external,
          idempotencyKey: `tracing:${external}`,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'round',
          gameId: 'game',
          kind: 'WIN',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
    }),
  );
} finally {
  broker.close();
}
async function get(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Observability check HTTP ${response.status}`);
  return response.json();
}
async function waitFor<T>(work: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 45000;
  do {
    try {
      const value = await work();
      if (ready(value)) return value;
    } catch {
      /* Services are starting. */
    }
    await Bun.sleep(250);
  } while (performance.now() < deadline);
  throw new Error('Observability services did not become ready');
}
const grafanaAuth = Buffer.from(
  `admin:${process.env.GRAFANA_PASSWORD ?? 'local-grafana'}`,
).toString('base64');
const dashboard = await waitFor(
  async () =>
    (await get('http://127.0.0.1:3300/api/dashboards/uid/jungle-wagering', {
      Authorization: `Basic ${grafanaAuth}`,
    })) as { dashboard: { title: string; panels: unknown[] } },
  (value) => value.dashboard.panels.length === 10,
);
if (dashboard.dashboard.panels.length !== 10) throw new Error('Dashboard was not provisioned');
const targets = await waitFor(
  async () =>
    (await get('http://127.0.0.1:9090/api/v1/targets')) as {
      data: { activeTargets: { health: string }[] };
    },
  (value) => value.data.activeTargets.filter((target) => target.health === 'up').length >= 3,
);
const healthy = targets.data.activeTargets.filter((target) => target.health === 'up').length;
if (healthy < 3) throw new Error('Expected three healthy Prometheus scrape targets');
const deadline = performance.now() + 30000;
let operations: string[] = [];
do {
  try {
    const result = (await get(`http://127.0.0.1:16686/api/traces/${traceId}`)) as {
      data: { spans: { operationName: string; traceID: string }[] }[];
    };
    const spans = result.data[0]?.spans ?? [];
    operations = [...new Set(spans.map((span) => span.operationName))];
    if (
      [
        'HTTP POST /wallets',
        'postgres.financial_transaction',
        'sqs.process',
        'outbox.publish',
      ].every((name) => operations.includes(name))
    )
      break;
  } catch {
    /* Wait for asynchronous OTLP batches and outbox publication. */
  }
  await Bun.sleep(250);
} while (performance.now() < deadline);
if (
  !['HTTP POST /wallets', 'postgres.financial_transaction', 'sqs.process', 'outbox.publish'].every(
    (name) => operations.includes(name),
  )
) {
  throw new Error(`Trace continuity check failed: ${operations.join(', ')}`);
}
console.log(
  JSON.stringify(
    {
      dashboard: dashboard.dashboard.title,
      panels: dashboard.dashboard.panels.length,
      healthyReplicas: healthy,
      traceId,
      operations,
      traceUrl: `http://localhost:16686/trace/${traceId}`,
    },
    null,
    2,
  ),
);
