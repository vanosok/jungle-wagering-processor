import type { BrokerPort } from '../../application/ports';
import { OutboxMessage } from '../../domain/messages';
import type { Database } from '../database/database';
import { errorCode, log, metrics } from '../observability';

interface ClaimedEvent {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

export class OutboxPublisher {
  private readonly owner = crypto.randomUUID();
  constructor(
    private readonly db: Database,
    private readonly broker: BrokerPort,
  ) {}

  async tick(): Promise<number> {
    // The lease is committed before network I/O; no SQL transaction waits on SQS.
    const rows = await this.db.em.fork().execute<ClaimedEvent[]>(
      `
      WITH candidates AS (
        SELECT id FROM outbox WHERE published_at IS NULL AND next_attempt_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_attempt_at, occurred_at, id FOR UPDATE SKIP LOCKED LIMIT 10
      ) UPDATE outbox o SET lease_owner = ?, lease_until = now() + interval '120 seconds'
      FROM candidates c WHERE o.id = c.id RETURNING o.*`,
      [this.owner],
    );
    await Promise.all(rows.map((row) => this.publish(row)));
    const [lag] = await this.db.em.fork().execute<{ seconds: string }[]>(`
      SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(enqueued_at)),0)::text AS seconds
      FROM outbox WHERE published_at IS NULL`);
    metrics.outboxLag.set(Math.max(0, Number(lag?.seconds ?? 0)));
    return rows.length;
  }

  private async publish(row: ClaimedEvent): Promise<void> {
    try {
      await this.broker.publish(row.id, row.aggregate_id, row.payload);
      await this.db.em.fork().execute(
        `UPDATE outbox SET published_at = now(), lease_owner = NULL,
        lease_until = NULL WHERE id = ? AND lease_owner = ? AND published_at IS NULL`,
        [row.id, this.owner],
      );
    } catch (error) {
      const message = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: new Date(row.next_attempt_at),
      });
      const [clock] = await this.db.em
        .fork()
        .execute<{ now: Date }[]>('select clock_timestamp() as now');
      if (!clock) throw new Error('Database clock unavailable');
      message.scheduleRetry(new Date(clock.now));
      await this.db.em.fork().execute(
        `UPDATE outbox SET attempts = ?, next_attempt_at = ?,
        lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ? AND published_at IS NULL`,
        [message.attempts, message.nextAttemptAt, row.id, this.owner],
      );
      metrics.retries.inc({ worker: 'outbox' });
      log('error', 'outbox_publish_retry', { worker: 'outbox', code: errorCode(error) });
    }
  }
}
