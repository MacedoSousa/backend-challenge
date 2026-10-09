import { describe, expect, it } from 'bun:test';
import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Env } from '../../../src/config/env';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { SqsMessagePublisher } from '../../../src/modules/messaging/infrastructure/sqs-message-publisher';

const AT = new Date('2026-10-09T12:00:00.000Z');

function message(id: string, aggregateId: string): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WalletBalanceChanged',
    payload: { eventId: id } as never,
    occurredAt: AT,
    attempts: 0,
    nextAttemptAt: AT,
    publishedAt: undefined,
  });
}

/** SQS falso: registra cada lote, mede quantos estavam em voo ao mesmo tempo. */
class FakeSqs {
  batches: SendMessageBatchRequestEntry[][] = [];
  inFlight = 0;
  maxInFlight = 0;
  failIds = new Set<string>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetQueueUrlCommand) return { QueueUrl: 'http://sqs/events.fifo' };
    if (!(command instanceof SendMessageBatchCommand)) throw new Error('comando inesperado');
    const entries = command.input.Entries ?? [];
    this.batches.push(entries);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Bun.sleep(5);
    this.inFlight -= 1;
    const failed = entries.filter((e) => this.failIds.has(e.MessageDeduplicationId ?? ''));
    return {
      Successful: entries.filter((e) => !failed.includes(e)).map((e) => ({ Id: e.Id })),
      Failed: failed.map((e) => ({ Id: e.Id, Code: 'Boom', SenderFault: false })),
    };
  }
}

function publisher(sqs: FakeSqs, concurrency = 4) {
  const env = { SQS_EVENTS_QUEUE: 'events.fifo', OUTBOX_PUBLISH_CONCURRENCY: concurrency } as Env;
  return new SqsMessagePublisher(sqs as unknown as SQSClient, env);
}

describe('SqsMessagePublisher', () => {
  it('envia lotes em paralelo (até OUTBOX_PUBLISH_CONCURRENCY) e publica todos', async () => {
    const sqs = new FakeSqs();
    const messages = Array.from({ length: 80 }, (_, i) => message(`m${i}`, `wallet-${i}`));

    const result = await publisher(sqs, 4).publish(messages);

    expect(result.failed).toEqual([]);
    expect(result.published.sort()).toEqual(messages.map((m) => m.id).sort());
    expect(sqs.batches.every((b) => b.length <= 10)).toBe(true);
    expect(sqs.maxInFlight).toBe(4);
  });

  it('mensagens da mesma wallet saem na ordem original, nunca em lotes concorrentes', async () => {
    const sqs = new FakeSqs();
    // 25 eventos da mesma wallet intercalados com eventos de outras
    const messages = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? message(`hot-${i}`, 'hot-wallet') : message(`m${i}`, `wallet-${i}`),
    );

    await publisher(sqs, 4).publish(messages);

    // a ordem global de chegada ao SQS, por grupo FIFO, é a ordem da outbox
    const hotOrder = sqs.batches
      .flat()
      .filter((e) => e.MessageGroupId === 'hot-wallet')
      .map((e) => e.MessageDeduplicationId);
    expect(hotOrder).toEqual(
      messages.filter((m) => m.aggregateId === 'hot-wallet').map((m) => m.id),
    );
  });

  it('falha parcial do lote: só as mensagens recusadas voltam como falha', async () => {
    const sqs = new FakeSqs();
    sqs.failIds.add('m3');
    const messages = Array.from({ length: 12 }, (_, i) => message(`m${i}`, `wallet-${i}`));

    const result = await publisher(sqs).publish(messages);

    expect(result.failed).toEqual([{ id: 'm3', reason: 'Boom' }]);
    expect(result.published).toHaveLength(11);
  });

  it('erro de rede num lote não derruba os outros', async () => {
    const sqs = new FakeSqs();
    const original = sqs.send.bind(sqs);
    sqs.send = async (command: unknown) => {
      if (
        command instanceof SendMessageBatchCommand &&
        command.input.Entries?.some((e) => e.MessageDeduplicationId === 'm0')
      ) {
        throw Object.assign(new Error('socket'), { name: 'NetworkingError' });
      }
      return original(command);
    };
    const messages = Array.from({ length: 30 }, (_, i) => message(`m${i}`, `wallet-${i}`));

    const result = await publisher(sqs, 3).publish(messages);

    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.failed.every((f) => f.reason === 'NetworkingError')).toBe(true);
    expect(result.published.length + result.failed.length).toBe(30);
    expect(result.published.length).toBeGreaterThan(0);
  });
});
