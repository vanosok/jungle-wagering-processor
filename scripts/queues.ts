import { SqsBroker } from '../src/infrastructure/messaging/sqs';

const broker = new SqsBroker();
try {
  await broker.initialize();
  console.log('SQS queues initialized');
} finally {
  broker.close();
}
