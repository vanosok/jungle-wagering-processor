import { DomainError } from './errors';

export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(props: Omit<InboxState, 'processedAt'>): InboxMessage {
    return new InboxMessage({ ...props });
  }
  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({ ...state });
  }
  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }
  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new DomainError('INBOX_CONFLICT', 'Inbox already processed');
    this.state.processedAt = new Date(at);
  }
  get processedAt() {
    return this.state.processedAt ? new Date(this.state.processedAt) : undefined;
  }
}

export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static enqueue(event: {
    toJSON(): Record<string, unknown>;
    eventId: string;
    aggregateId: string;
    eventType: string;
    occurredAt: Date;
  }): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: new Date(),
    });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt() {
    return new Date(this.state.nextAttemptAt);
  }
  get publishedAt() {
    return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined;
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt <= now;
  }
  markPublished(at: Date): void {
    this.state.publishedAt = new Date(at);
  }
  scheduleRetry(now: Date): void {
    this.state.attempts += 1;
    this.state.nextAttemptAt = new Date(
      now.getTime() + Math.min(60_000, 1000 * 2 ** Math.min(this.attempts - 1, 10)),
    );
  }
}
