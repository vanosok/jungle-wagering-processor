// Provisioned, version-controlled operational dashboard; no manual setup is needed.
export {};
const charts = [
  ['Transaction outcomes / second', 'sum by (status) (rate(wager_transactions_total[5m]))', 'ops'],
  ['HTTP + consumer latency p50 / p95 / p99', '', 's'],
  ['Duplicate detections / second', 'sum by (source) (rate(wager_duplicates_total[5m]))', 'ops'],
  ['Retries / second', 'sum by (worker) (rate(wager_retries_total[5m]))', 'ops'],
  ['DLQ messages', 'sum(wager_dlq_total)', 'short'],
  ['Lock conflicts', 'sum(wager_lock_conflicts_total)', 'short'],
  ['Oldest unpublished event (per replica)', 'wager_outbox_lag_seconds', 's'],
  ['Reconciliation mismatches', 'sum(wager_reconciliation_mismatches_total)', 'short'],
  ['Healthy scrape targets', 'sum(up{job="wagering"})', 'short'],
  ['Memory per replica', 'process_resident_memory_bytes', 'bytes'],
] as const;
const panels = charts.map(([title, expr, unit], index) => ({
  id: index + 1,
  title,
  type: 'timeseries',
  datasource: { type: 'prometheus', uid: 'prometheus' },
  gridPos: { x: (index % 2) * 12, y: Math.floor(index / 2) * 8, w: 12, h: 8 },
  fieldConfig: { defaults: { unit }, overrides: [] },
  targets: expr
    ? [{ refId: 'A', expr, legendFormat: '{{status}}{{source}}{{worker}}{{instance}}' }]
    : [0.5, 0.95, 0.99].map((quantile, i) => ({
        refId: String.fromCharCode(65 + i),
        expr: `histogram_quantile(${quantile}, sum by (le) (rate(wager_processing_seconds_bucket[5m])))`,
        legendFormat: `p${quantile * 100}`,
      })),
}));
await Bun.write(
  'ops/grafana/dashboards/wagering.json',
  `${JSON.stringify(
    {
      uid: 'jungle-wagering',
      title: 'Jungle — Financial Operations',
      schemaVersion: 40,
      version: 1,
      timezone: 'browser',
      refresh: '5s',
      time: { from: 'now-15m', to: 'now' },
      panels,
      links: [
        { title: 'Distributed traces (Jaeger)', url: 'http://localhost:16686', targetBlank: true },
      ],
    },
    null,
    2,
  )}\n`,
);
