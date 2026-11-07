import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { messageSchema, payloadHash, type TransactionInput } from '../../application/contracts';
import type { RequestContext } from '../../application/ports';
import type { WageringService } from '../../application/wagering';
import { config } from '../../config';
import { DomainError } from '../../domain/errors';
import { errorCode, log, metrics } from '../observability';
import type { SqsBroker } from './sqs';

export class SqsConsumer {
  private stopping = false;
  private active = new Map<string, string>();
  private receiveAbort = new AbortController();
  constructor(
    private readonly broker: SqsBroker,
    private readonly service: WageringService,
    private readonly afterCommit?: (message: Message) => Promise<void>,
  ) {}

  stop(): void {
    this.stopping = true;
    this.receiveAbort.abort();
  }

  async tick(waitSeconds = 10): Promise<number> {
    if (this.stopping) return 0;
    const url = await this.broker.url(this.broker.names.requests);
    const response = await this.broker.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: config.SQS_VISIBILITY_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.receiveAbort.signal },
    );
    const groups = new Map<string, Message[]>();
    for (const message of response.Messages ?? []) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'unknown';
      const messages = groups.get(group) ?? [];
      messages.push(message);
      groups.set(group, messages);
    }
    await Promise.all(
      [...groups.values()].map(async (messages) => {
        for (const message of messages) {
          if (this.stopping) {
            if (message.ReceiptHandle) await this.visibility(url, message.ReceiptHandle, 0);
          } else await this.handle(url, message);
        }
      }),
    );
    return response.Messages?.length ?? 0;
  }

  private async handle(url: string, message: Message): Promise<void> {
    const handle = message.ReceiptHandle;
    if (!handle) return;
    this.active.set(handle, url);
    const heartbeat = setInterval(
      () => {
        void this.visibility(url, handle, config.SQS_VISIBILITY_SECONDS).catch(() => {
          log('error', 'visibility_extension_failed', { messageId: message.MessageId });
        });
      },
      Math.max(1000, Math.floor((config.SQS_VISIBILITY_SECONDS * 1000) / 3)),
    );
    let correlationId = message.MessageId ?? crypto.randomUUID();
    let walletId: string | undefined;
    let providerId: string | undefined;
    let accepted: { data: TransactionInput; key: string; context: RequestContext } | undefined;
    const end = metrics.latency.startTimer();
    try {
      const envelope = messageSchema.safeParse(JSON.parse(message.Body ?? 'null'));
      if (!envelope.success) throw new DomainError('INVALID_INPUT', 'Invalid SQS envelope');
      const { idempotencyKey, ...data } = envelope.data.data;
      walletId = data.walletId;
      providerId = data.providerId;
      correlationId = envelope.data.messageId;
      const context: RequestContext = {
        correlationId,
        causationId: envelope.data.messageId,
        inbox: {
          consumerName: 'wagering-v1',
          messageId: envelope.data.messageId,
          payloadHash: payloadHash(envelope.data.data),
        },
      };
      accepted = { data, key: idempotencyKey, context };
      const outcome = await this.service.submit(data, idempotencyKey, context);
      metrics.transactions.inc({ status: outcome.status });
      if (outcome.idempotentReplay) metrics.duplicates.inc({ source: 'sqs' });
      log('info', 'sqs_transaction_committed', {
        correlationId,
        walletId,
        providerId,
        messageId: envelope.data.messageId,
        transactionId: outcome.transactionId,
      });
      // Test seam also proves the real process-death window after commit and before ack.
      await this.afterCommit?.(message);
      await this.broker.client.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle }),
      );
    } catch (error) {
      const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      const permanent = error instanceof DomainError || error instanceof SyntaxError;
      if (permanent || count >= config.SQS_MAX_RECEIVES) {
        if (!permanent && accepted) {
          try {
            const outcome = await this.service.recordPermanentFailure(
              accepted.data,
              accepted.key,
              accepted.context,
            );
            if (outcome.status === 'FAILED') metrics.transactions.inc({ status: 'FAILED' });
          } catch (auditError) {
            // If PostgreSQL is still unavailable, the DLQ retains the original envelope for operator recovery.
            log('error', 'failed_transaction_audit_unavailable', {
              correlationId,
              messageId: message.MessageId,
              walletId,
              providerId,
              code: errorCode(auditError),
            });
          }
        }
        await this.broker.client.send(
          new SendMessageCommand({
            QueueUrl: await this.broker.url(this.broker.names.dlq),
            MessageBody: message.Body ?? '{}',
            MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid',
            MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
            MessageAttributes: {
              FailureCode: { DataType: 'String', StringValue: errorCode(error) },
            },
          }),
        );
        await this.broker.client.send(
          new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle }),
        );
        metrics.dlq.inc();
        log('error', 'message_sent_to_dlq', {
          correlationId,
          messageId: message.MessageId,
          walletId,
          providerId,
          code: errorCode(error),
        });
      } else {
        await this.visibility(url, handle, Math.min(60, 2 ** Math.min(count, 6)));
        metrics.retries.inc({ worker: 'consumer' });
        log('error', 'sqs_retry_scheduled', {
          correlationId,
          messageId: message.MessageId,
          walletId,
          providerId,
          code: errorCode(error),
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(handle);
      end();
    }
  }

  private async visibility(url: string, handle: string, seconds: number): Promise<void> {
    await this.broker.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: url,
        ReceiptHandle: handle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async release(): Promise<void> {
    await Promise.allSettled(
      [...this.active].map(([handle, url]) => this.visibility(url, handle, 0)),
    );
  }
}
