import { MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { OutboxStore } from '../../../shared/application/ports';
import type { IntegrationEventEnvelope } from '../domain/integration-event';
import { OutboxMessage } from '../domain/outbox-message';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: IntegrationEventEnvelope<unknown>;
  /** O MikroORM configura o driver para devolver timestamptz como texto no SQL direto. */
  occurred_at: string | Date;
  attempts: number;
  next_attempt_at: string | Date;
}

/**
 * Outbox em SQL explícito: o claim precisa de `FOR UPDATE SKIP LOCKED` + lease num único
 * comando, o que fica mais claro (e auditável) em SQL do que no Unit of Work.
 */
@Injectable()
export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue({
    instanceId,
    now,
    leaseMs,
    limit,
  }: Parameters<OutboxStore['claimDue']>[0]): Promise<OutboxMessage[]> {
    const rows = await this.execute<OutboxRow>(
      `UPDATE outbox_messages o
          SET locked_by = ?, locked_until = ?::timestamptz + (? * interval '1 millisecond')
        WHERE o.id IN (
              SELECT id FROM outbox_messages
               WHERE published_at IS NULL
                 AND next_attempt_at <= ?
                 AND (locked_until IS NULL OR locked_until < ?)
               ORDER BY occurred_at, id
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
       RETURNING o.id, o.aggregate_id, o.event_type, o.payload, o.occurred_at, o.attempts,
                 o.next_attempt_at`,
      [instanceId, now, leaseMs, now, now, limit],
    );
    const messages = rows.map((row) =>
      OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        occurredAt: new Date(row.occurred_at),
        attempts: row.attempts,
        nextAttemptAt: new Date(row.next_attempt_at),
        publishedAt: undefined,
      }),
    );
    // RETURNING não preserva ordem: reordena para publicar na ordem de ocorrência
    return messages.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
    );
  }

  async markPublished(ids: string[], instanceId: string, at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.execute<{ id: string }>(
      `UPDATE outbox_messages
          SET published_at = ?, locked_by = NULL, locked_until = NULL
        WHERE id = ANY(?::uuid[]) AND locked_by = ? AND published_at IS NULL
       RETURNING id`,
      [at, `{${ids.join(',')}}`, instanceId],
    );
    return rows.length;
  }

  async reschedule(message: OutboxMessage, instanceId: string): Promise<void> {
    await this.execute(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL
        WHERE id = ? AND locked_by = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? new Date(), message.id, instanceId],
    );
  }

  async lagSeconds(now: Date): Promise<number> {
    const [row] = await this.execute<{ lag: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (?::timestamptz - min(occurred_at)))::text AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    return row?.lag ? Math.max(0, Number.parseFloat(row.lag)) : 0;
  }

  private execute<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.orm.em.fork().getConnection().execute<T[]>(sql, params);
  }
}
