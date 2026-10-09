import { InvariantViolationError } from '../../../shared/domain/domain-error';
import type { IntegrationEvent, IntegrationEventEnvelope } from './integration-event';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope<unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
}

/**
 * Evento aguardando publicação. Gravado na mesma transação SQL da mudança financeira;
 * publicado depois do commit por um worker (Transactional Outbox, ADR-09).
 */
export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: new Date(event.occurredAt),
      attempts: 0,
      nextAttemptAt: new Date(event.occurredAt),
      publishedAt: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id() {
    return this.state.id;
  }
  get aggregateId() {
    return this.state.aggregateId;
  }
  get eventType() {
    return this.state.eventType;
  }
  get payload(): Readonly<IntegrationEventEnvelope<unknown>> {
    return this.state.payload;
  }
  get occurredAt() {
    return new Date(this.state.occurredAt);
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.isPending() ? new Date(this.state.nextAttemptAt) : undefined;
  }
  get publishedAt() {
    return this.state.publishedAt && new Date(this.state.publishedAt);
  }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this.state.nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.state.publishedAt = new Date(at);
  }

  /** Incrementa attempts e agenda a próxima tentativa: 1s, 2s, 4s… até 5 min. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this.state.attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this.state.attempts - 1), MAX_DELAY_MS);
    this.state.nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`outbox ${this.state.id} já foi publicada`);
    }
  }
}
