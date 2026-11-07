import type { WageringService } from '../application/wagering';
import type { Database } from './database/database';
import { SqsConsumer } from './messaging/consumer';
import { OutboxPublisher } from './messaging/outbox-publisher';
import { ReferenceWorker } from './messaging/reference-worker';
import type { SqsBroker } from './messaging/sqs';
import { errorCode, log } from './observability';

export class Workers {
  private stopping = false;
  private tasks: Promise<void>[] = [];
  readonly consumer: SqsConsumer;
  readonly publisher: OutboxPublisher;
  readonly references: ReferenceWorker;
  constructor(db: Database, broker: SqsBroker, service: WageringService) {
    this.consumer = new SqsConsumer(broker, service);
    this.publisher = new OutboxPublisher(db, broker);
    this.references = new ReferenceWorker(db, service);
  }
  start(): void {
    this.tasks = [
      this.loop('consumer', () => this.consumer.tick(), 25),
      this.loop('outbox', () => this.publisher.tick(), 100),
      this.loop('reference', () => this.references.tick(), 250),
    ];
  }
  private async loop(name: string, work: () => Promise<unknown>, delay: number) {
    while (!this.stopping) {
      try {
        await work();
      } catch (error) {
        if (!this.stopping)
          log('error', 'worker_iteration_failed', { worker: name, code: errorCode(error) });
      }
      if (!this.stopping) await Bun.sleep(delay);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.consumer.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(this.tasks).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 30000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) await this.consumer.release();
  }
}
