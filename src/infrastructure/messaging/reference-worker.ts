import type { WageringService } from '../../application/wagering';
import type { Database } from '../database/database';
import { errorCode, log, metrics } from '../observability';

export class ReferenceWorker {
  constructor(
    private readonly db: Database,
    private readonly service: WageringService,
  ) {}
  async tick(): Promise<number> {
    const due = await this.db.em
      .fork()
      .execute<{ provider_id: string; external_transaction_id: string }[]>(`
      SELECT provider_id, external_transaction_id FROM wager_transactions
      WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT 25`);
    let processed = 0;
    // No row claim is held before the financial lock order. The use case rechecks due/status under locks.
    await Promise.all(
      due.map(async (row) => {
        try {
          if (await this.service.retryReference(row.provider_id, row.external_transaction_id)) {
            metrics.retries.inc({ worker: 'reference' });
            const [outcome] = await this.db.em
              .fork()
              .execute<{ status: string }[]>(
                'select status from wager_transactions where provider_id = ? and external_transaction_id = ?',
                [row.provider_id, row.external_transaction_id],
              );
            if (outcome) metrics.transactions.inc({ status: outcome.status });
            processed += 1;
          }
        } catch (error) {
          log('error', 'reference_retry_failed', { worker: 'reference', code: errorCode(error) });
        }
      }),
    );
    return processed;
  }
}
