import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { BrokerPort } from '../../application/ports';
import { config } from '../../config';
import { traceCarrier } from '../telemetry';

export const queueNames = {
  requests: 'wager-transactions.fifo',
  dlq: 'wager-transactions-dlq.fifo',
  events: 'wager-events.fifo',
} as const;

export class SqsBroker implements BrokerPort {
  readonly client: SQSClient;
  readonly names: { requests: string; dlq: string; events: string };
  private urls = new Map<string, string>();
  constructor(prefix = process.env.SQS_QUEUE_PREFIX ?? '') {
    if (!/^[A-Za-z0-9_-]{0,40}$/.test(prefix)) throw new Error('Invalid SQS queue prefix');
    this.names = {
      requests: `${prefix}${queueNames.requests}`,
      dlq: `${prefix}${queueNames.dlq}`,
      events: `${prefix}${queueNames.events}`,
    };
    this.client = new SQSClient({
      region: config.AWS_REGION,
      endpoint: config.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
      maxAttempts: 2,
      requestHandler: { requestTimeout: 25000, connectionTimeout: 2000 },
    });
  }
  async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const response = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!response.QueueUrl) throw new Error('SQS queue URL missing');
    this.urls.set(name, response.QueueUrl);
    return response.QueueUrl;
  }
  async initialize(): Promise<void> {
    for (const name of [this.names.dlq, this.names.events, this.names.requests]) {
      await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: String(config.SQS_VISIBILITY_SECONDS),
            ReceiveMessageWaitTimeSeconds: '10',
          },
        }),
      );
    }
    const dlq = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.url(this.names.dlq),
        AttributeNames: ['QueueArn'],
      }),
    );
    await this.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: await this.url(this.names.requests),
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlq.Attributes?.QueueArn,
            maxReceiveCount: config.SQS_MAX_RECEIVES,
          }),
        },
      }),
    );
  }
  async publish(
    eventId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(this.names.events),
        MessageBody: JSON.stringify(payload),
        MessageGroupId: aggregateId,
        MessageDeduplicationId: eventId,
        MessageAttributes: Object.fromEntries(
          Object.entries(traceCarrier()).map(([key, value]) => [
            key,
            { DataType: 'String', StringValue: value },
          ]),
        ),
      }),
    );
  }
  async ready(): Promise<void> {
    await Promise.all(
      Object.values(this.names).map(async (name) => {
        await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.url(name),
            AttributeNames: ['QueueArn'],
          }),
          { abortSignal: AbortSignal.timeout(2000) },
        );
      }),
    );
  }
  close(): void {
    this.client.destroy();
  }
}
