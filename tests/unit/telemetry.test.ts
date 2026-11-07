import { afterAll, expect, test } from 'bun:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import {
  flushTelemetry,
  startTelemetry,
  stopTelemetry,
  traceCarrier,
  traceContext,
  traced,
} from '../../src/infrastructure/telemetry';

const exporter = new InMemorySpanExporter();
startTelemetry(exporter);
afterAll(async () => {
  await stopTelemetry();
});
test('W3C trace context survives durable transport metadata without recording amounts', async () => {
  let carrier: Record<string, string> = {};
  await traced('http.example', async () => {
    await traced('postgres.financial_transaction', async () => {
      carrier = traceCarrier();
    });
  });
  await traced(
    'outbox.publish',
    async () => {
      await traced('sqs.process', async () => {});
    },
    {},
    traceContext(carrier),
  );
  await flushTelemetry();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(4);
  expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  expect(carrier.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('amount');
});
