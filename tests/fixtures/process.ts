import { WageringService } from '../../src/application/wagering';
import { connectDatabase } from '../../src/infrastructure/database/database';
import { PostgresFinancialStore } from '../../src/infrastructure/database/store';
import { SqsConsumer } from '../../src/infrastructure/messaging/consumer';
import { SqsBroker } from '../../src/infrastructure/messaging/sqs';
import { bootstrap } from '../../src/main';

const mode = process.argv[2];
if (mode === 'api') {
  const instance = await bootstrap(0, false);
  console.log(`READY:${instance.port}`);
  process.once('SIGTERM', () => {
    void instance.close().then(() => process.exit(0));
  });
} else if (mode === 'crash-consumer') {
  const db = await connectDatabase();
  const broker = new SqsBroker();
  const service = new WageringService(new PostgresFinancialStore(db));
  const consumer = new SqsConsumer(broker, service, async () => {
    // Kill the OS process at the exact commit/ack boundary, without graceful cleanup.
    process.kill(process.pid, 'SIGKILL');
  });
  await consumer.tick(0);
  await db.close(true);
  broker.close();
} else {
  throw new Error('Unknown fixture mode');
}
