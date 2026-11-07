import { trace } from '@opentelemetry/api';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { config } from '../config';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Submission/retry outcomes after commit, including replays',
    labelNames: ['status'],
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Persistent duplicates',
    labelNames: ['source'],
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled',
    labelNames: ['worker'],
    registers: [registry],
  }),
  dlq: new Counter({
    name: 'wager_dlq_total',
    help: 'Messages moved to DLQ',
    registers: [registry],
  }),
  lockConflicts: new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Deadlocks, timeouts and serialization retries',
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: 'wager_outbox_lag_seconds',
    help: 'Age of oldest unpublished event',
    registers: [registry],
  }),
  reconciliation: new Counter({
    name: 'wager_reconciliation_mismatches_total',
    help: 'Detected ledger divergence',
    registers: [registry],
  }),
  latency: new Histogram({
    name: 'wager_processing_seconds',
    help: 'Transaction processing duration',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 3, 10],
    registers: [registry],
  }),
};

// Allowlist: never spread raw requests, SDK errors or financial payloads into logs.
export function log(
  level: 'info' | 'error',
  event: string,
  context: {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
    code?: string;
    worker?: string;
  } = {},
): void {
  if (config.LOG_LEVEL === 'silent' || (config.LOG_LEVEL === 'error' && level === 'info')) return;
  const span = trace.getActiveSpan()?.spanContext();
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context,
    ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  if (error && typeof error === 'object' && 'cause' in error) return errorCode(error.cause);
  return error instanceof Error ? error.name : 'UNKNOWN';
}
