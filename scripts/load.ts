import os from 'node:os';
import { z } from 'zod';
import { Money } from '../src/domain/money';

const raw = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=');
    return [key, value.join('=')];
  }),
);
const options = z
  .strictObject({
    urls: z
      .string()
      .default(process.env.API_URLS ?? process.env.API_URL ?? 'http://localhost:3000'),
    requests: z.coerce.number().int().min(10).max(50000).default(600),
    concurrency: z.coerce.number().int().min(1).max(100).default(12),
    wallets: z.coerce.number().int().min(1).max(100).default(12),
    scenario: z.enum(['hot', 'distributed']).default('distributed'),
  })
  .parse(raw);
const urls = [
  ...new Set(
    options.urls.split(',').map((value) => {
      const url = new URL(value);
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
        throw new Error('Invalid API URL');
      return url.origin;
    }),
  ),
];
const runId = crypto.randomUUID();
async function dockerEnvironment() {
  try {
    const child = Bun.spawn(['docker', 'info', '--format', '{{json .}}'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const value = JSON.parse(await new Response(child.stdout).text()) as {
      ServerVersion: string;
      NCPU: number;
      MemTotal: number;
      OperatingSystem: string;
    };
    if ((await child.exited) !== 0) return null;
    return {
      version: value.ServerVersion,
      logicalCpus: value.NCPU,
      memoryBytes: value.MemTotal,
      os: value.OperatingSystem,
    };
  } catch {
    return null;
  }
}
const docker = await dockerEnvironment();
const initial = Money.from({ amount: '1000000.00', currency: 'BRL' });
const stake = Money.from({ amount: '0.01', currency: 'BRL' });
const wallets: { id: string; playerId: string; expected: Money; operations: number }[] = [];
async function post(base: string, path: string, body: unknown, key?: string) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
const walletCount = options.scenario === 'hot' ? 1 : options.wallets;
for (let i = 0; i < walletCount; i++) {
  const response = await post(urls[i % urls.length] as string, '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: initial.toJSON(),
  });
  if (response.status !== 201) throw new Error(`Wallet setup failed: HTTP ${response.status}`);
  const wallet = (await response.json()) as { id: string; playerId: string };
  wallets.push({ ...wallet, expected: initial, operations: 0 });
}
type Job = { key: string; wallet: number; data: Record<string, unknown> };
const jobs: Job[] = [];
for (let i = 0; i < options.requests; i++) {
  if (i > 0 && i % 10 === 0) {
    const previous = jobs[i - 1];
    if (previous) jobs.push(previous);
    continue;
  }
  const index = i % walletCount;
  const wallet = wallets[index];
  if (!wallet) throw new Error('Missing load wallet');
  const external = crypto.randomUUID();
  jobs.push({
    key: `load:${runId}:${external}`,
    wallet: index,
    data: {
      providerId: 'load-test',
      externalTransactionId: external,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: runId,
      gameId: 'load-test',
      kind: 'BET',
      money: stake.toJSON(),
    },
  });
  wallet.expected = wallet.expected.subtract(stake);
  wallet.operations++;
}
async function serverMetrics() {
  return Promise.all(
    urls.map(async (url) => {
      try {
        const response = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return { url, available: false };
        const body = await response.text();
        const metric = (name: string) => {
          const line = body.split('\n').find((value) => value.startsWith(`${name} `));
          return line ? Number(line.slice(name.length + 1)) : null;
        };
        return {
          url,
          available: true,
          lockConflicts: metric('wager_lock_conflicts_total'),
          outboxLagSeconds: metric('wager_outbox_lag_seconds'),
        };
      } catch {
        return { url, available: false };
      }
    }),
  );
}
const before = await serverMetrics();
const latencies: number[] = [];
const statusCounts: Record<string, number> = {};
const identities = new Map<string, { id: string; balance: string; originals: number }>();
const violations: string[] = [];
let next = 0;
let errors = 0;
let replays = 0;
const startedAt = new Date().toISOString();
const started = performance.now();
await Promise.all(
  Array.from({ length: options.concurrency }, async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      if (!job) break;
      const start = performance.now();
      try {
        const response = await post(
          urls[index % urls.length] as string,
          '/wagering/transactions',
          job.data,
          job.key,
        );
        statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
        if (response.status !== 200) {
          errors++;
          await response.arrayBuffer();
          continue;
        }
        const value = (await response.json()) as {
          transactionId: string;
          status: string;
          balance: { amount: string };
          idempotentReplay: boolean;
        };
        if (
          value.status !== 'PROCESSED' ||
          !value.transactionId ||
          typeof value.balance?.amount !== 'string'
        ) {
          errors++;
          continue;
        }
        const existing = identities.get(job.key);
        if (
          existing &&
          (existing.id !== value.transactionId || existing.balance !== value.balance.amount)
        )
          violations.push('Unstable idempotent result');
        const originals = (existing?.originals ?? 0) + (value.idempotentReplay ? 0 : 1);
        identities.set(job.key, {
          id: value.transactionId,
          balance: value.balance.amount,
          originals,
        });
        if (value.idempotentReplay) replays++;
      } catch {
        errors++;
        statusCounts.network_error = (statusCounts.network_error ?? 0) + 1;
      } finally {
        latencies.push(performance.now() - start);
      }
    }
  }),
);
const durationSeconds = (performance.now() - started) / 1000;
const uniqueExpected = new Set(jobs.map((job) => job.key)).size;
if (
  identities.size !== uniqueExpected ||
  [...identities.values()].some((identity) => identity.originals !== 1)
)
  violations.push('Unexpected number of original operations');
const reconciliations = [];
for (const [i, wallet] of wallets.entries()) {
  const response = await post(
    urls[i % urls.length] as string,
    `/wallets/${wallet.id}/reconciliation`,
    {},
  );
  const value = (await response.json()) as {
    consistent: boolean;
    storedBalance: { amount: string };
    checkedEntries: number;
    doubleEntry: { consistent: boolean; checkedPostings: number };
  };
  const ok =
    response.ok &&
    value.consistent &&
    value.doubleEntry?.consistent &&
    value.storedBalance?.amount === wallet.expected.toString() &&
    value.checkedEntries === wallet.operations + 1 &&
    value.doubleEntry.checkedPostings === 2 * value.checkedEntries;
  reconciliations.push({
    walletId: wallet.id,
    consistent: ok,
    checkedEntries: value.checkedEntries,
    checkedPostings: value.doubleEntry?.checkedPostings,
  });
  if (!ok) violations.push('Wallet/ledger/journal reconciliation failed');
}
const after = await serverMetrics();
latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? 0;
const report = {
  runId,
  startedAt,
  environment: {
    runtime: `Bun ${Bun.version}`,
    os: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    docker,
    note: 'Local synthetic closed-loop workload; results depend on Docker resources and instrumentation. No production capacity claim.',
  },
  methodology: {
    ...options,
    effectiveWallets: walletCount,
    replicasTargeted: urls.length,
    stake: stake.toJSON(),
    urls,
    duplicateEvery: 10,
    warmup: 'Wallet creation and metrics scrape precede the measured request phase.',
    latency:
      'Client request through full response body; monotonic milliseconds, includes API/DB contention, excludes job scheduling.',
    financialChecks:
      'Expected unique effects, original replay snapshots, wallet=ledger, debit=credit and exactly two postings per movement.',
  },
  results: {
    requests: jobs.length,
    uniqueExpected,
    replays,
    durationSeconds,
    requestsPerSecond: jobs.length / durationSeconds,
    errors,
    errorRate: errors / jobs.length,
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latencies.at(-1) ?? 0,
    },
    statusCounts,
    metricsBefore: before,
    metricsAfter: after,
    lockConflictsDuringRun: after.reduce(
      (sum, item, i) =>
        sum + Math.max(0, (item.lockConflicts ?? 0) - (before[i]?.lockConflicts ?? 0)),
      0,
    ),
    reconciliations,
    violations,
    passed: errors === 0 && violations.length === 0,
  },
};
const path = `benchmarks/${options.scenario}-${options.requests}-${options.concurrency}.json`;
await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: path, ...report.results }, null, 2));
if (!report.results.passed) process.exitCode = 1;
