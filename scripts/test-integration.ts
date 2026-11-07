import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { config } from '../src/config';
import { connectDatabase } from '../src/infrastructure/database/database';
import { SqsBroker } from '../src/infrastructure/messaging/sqs';

// A new database and three new queues per run; never reset the development database.
const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `wagering_test_${runId}`;
const testUrl = new URL(config.DATABASE_URL);
testUrl.pathname = `/${databaseName}`;
const admin = await connectDatabase();
const broker = new SqsBroker(`test-${runId}-`);
let exitCode = 1;
try {
  await admin.em.fork().execute(`CREATE DATABASE "${databaseName}"`);
  const db = await connectDatabase(testUrl.toString());
  try {
    await db.migrator.up();
    await db.migrator.down({ to: 0 });
    await db.migrator.up();
  } finally {
    await db.close(true);
  }
  await broker.initialize();
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--timeout',
      '120000',
      'tests/integration',
      ...process.argv.slice(2),
    ],
    {
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: testUrl.toString(),
        SQS_QUEUE_PREFIX: `test-${runId}-`,
        LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
        SQS_VISIBILITY_SECONDS: '2',
        SQS_MAX_RECEIVES: '2',
        REFERENCE_BASE_DELAY_MS: '20',
        REFERENCE_MAX_DELAY_MS: '100',
        REFERENCE_MAX_ATTEMPTS: '3',
      },
    },
  );
  exitCode = await child.exited;
} finally {
  await Promise.allSettled(
    Object.values(broker.names).map(async (name) => {
      await broker.client.send(new DeleteQueueCommand({ QueueUrl: await broker.url(name) }));
    }),
  );
  broker.close();
  await admin.em.fork().execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.close(true);
}
process.exit(exitCode);
