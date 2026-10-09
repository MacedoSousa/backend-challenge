import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import type { MessagePublisher, PublishResult } from '../../../shared/application/ports';
import { queueUrl } from '../../../shared/infrastructure/sqs/queues';
import { SQS_CLIENT } from '../../../shared/infrastructure/sqs/sqs.module';
import type { OutboxMessage } from '../domain/outbox-message';

/** Limite do SendMessageBatch. */
const SQS_BATCH_LIMIT = 10;

/**
 * Publica na fila FIFO de eventos com `MessageGroupId = aggregateId` (ordem por wallet) e
 * `MessageDeduplicationId = eventId` (republicação na janela de 5 min é descartada pelo SQS;
 * fora dela, o consumidor deduplica por eventId).
 */
@Injectable()
export class SqsMessagePublisher implements MessagePublisher {
  private cachedUrl: string | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult> {
    const result: PublishResult = { published: [], failed: [] };
    let url: string | undefined;
    try {
      url = await this.queueUrl();
    } catch (error) {
      return failAll(messages, error);
    }
    if (!url) return failAll(messages, new Error(`fila ${this.env.SQS_EVENTS_QUEUE} inexistente`));

    // faixas paralelas; dentro de cada uma os lotes saem em série. Todas as mensagens de uma
    // wallet caem na mesma faixa, então a ordem do grupo FIFO é a ordem da outbox
    const lanes = partitionByAggregate(messages, this.env.OUTBOX_PUBLISH_CONCURRENCY);
    await Promise.all(
      lanes.map(async (lane) => {
        for (let start = 0; start < lane.length; start += SQS_BATCH_LIMIT) {
          await this.sendBatch(url, lane.slice(start, start + SQS_BATCH_LIMIT), result);
        }
      }),
    );
    return result;
  }

  private async sendBatch(url: string, chunk: OutboxMessage[], result: PublishResult) {
    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
            },
          })),
        }),
      );
      for (const ok of response.Successful ?? []) {
        const message = chunk[Number(ok.Id)];
        if (message) result.published.push(message.id);
      }
      for (const failure of response.Failed ?? []) {
        const message = chunk[Number(failure.Id)];
        if (message) result.failed.push({ id: message.id, reason: failure.Code ?? 'unknown' });
      }
    } catch (error) {
      this.cachedUrl = undefined;
      result.failed.push(...failAll(chunk, error).failed);
    }
  }

  private async queueUrl(): Promise<string | undefined> {
    this.cachedUrl ??= await queueUrl(this.sqs, this.env.SQS_EVENTS_QUEUE);
    return this.cachedUrl;
  }
}

/**
 * Distribui as mensagens em até `lanes` faixas, preservando a ordem relativa e mantendo cada
 * `aggregateId` inteiro numa faixa só. Faixas equilibradas por volume (a de menor carga recebe
 * o próximo agregado novo).
 */
export function partitionByAggregate(messages: OutboxMessage[], lanes: number): OutboxMessage[][] {
  const result: OutboxMessage[][] = Array.from({ length: Math.max(1, lanes) }, () => []);
  const laneOf = new Map<string, OutboxMessage[]>();
  for (const message of messages) {
    let lane = laneOf.get(message.aggregateId);
    if (!lane) {
      lane = result.reduce((smallest, l) => (l.length < smallest.length ? l : smallest));
      laneOf.set(message.aggregateId, lane);
    }
    lane.push(message);
  }
  return result.filter((lane) => lane.length > 0);
}

function failAll(messages: OutboxMessage[], error: unknown): PublishResult {
  const reason = error instanceof Error ? error.name : 'unknown';
  return { published: [], failed: messages.map((message) => ({ id: message.id, reason })) };
}
