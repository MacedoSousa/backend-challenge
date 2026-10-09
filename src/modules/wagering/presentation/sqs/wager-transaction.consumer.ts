import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../../config/config.module';
import type { Env } from '../../../../config/env';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
  METRICS,
  type Metrics,
} from '../../../../shared/application/ports';
import { DomainError, InvariantViolationError } from '../../../../shared/domain/domain-error';
import {
  enrichContext,
  runWithContext,
} from '../../../../shared/infrastructure/logging/request-context';
import { InjectedFaultError } from '../../../../shared/infrastructure/platform.module';
import { queueUrl } from '../../../../shared/infrastructure/sqs/queues';
import { SQS_CLIENT } from '../../../../shared/infrastructure/sqs/sqs.module';
import { InboxMessage } from '../../../messaging/domain/inbox-message';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import { canonicalJson } from '../../domain/payload-hash';
import {
  type WagerTransactionRequested,
  WagerTransactionRequestedMessage,
} from '../wager-contract';

const MAX_BATCH = 10;
const MAX_BACKOFF_SECONDS = 300;

/** Erro permanente: a mensagem nunca será processável — vai direto para a DLQ. */
class PermanentMessageError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Consumidor de `wager-transactions.fifo` (papel `consumer`, §10):
 * - reutiliza o mesmo use case da API (`executeFromQueue`), com inbox na mesma transação;
 * - ack (`DeleteMessage`) **só depois do commit**;
 * - negócio → ack; transitório → backoff de visibilidade; na última recepção, registra a
 *   operação como `FAILED INFRA_RETRIES_EXHAUSTED` e a manda à DLQ; permanente ou bug → DLQ
 *   imediata;
 * - mensagens de grupos diferentes em paralelo; do mesmo grupo, em ordem — uma falha
 *   transitória devolve também as seguintes do grupo, sem processá-las;
 * - `SIGTERM`: para de receber, conclui o que está em andamento e devolve o resto.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private receiving: AbortController | undefined;
  private urls: { main: string; dlq: string } | undefined;

  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.APP_ROLE.includes('consumer')) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info(
      { component: 'consumer', queue: this.env.SQS_WAGER_QUEUE },
      'consumer started',
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.receiving?.abort();
    const deadline = Bun.sleep(this.env.CONSUMER_SHUTDOWN_TIMEOUT_MS).then(
      () => 'timeout' as const,
    );
    if ((await Promise.race([this.loop, deadline])) === 'timeout') {
      this.logger.warn(
        { component: 'consumer' },
        'shutdown timeout: in-flight messages will be redelivered',
      );
      return;
    }
    this.logger.warn({ component: 'consumer' }, 'consumer drained: graceful shutdown complete');
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const urls = await this.resolveUrls();
        const messages = await this.receive(urls.main);
        await this.processBatch(messages, urls);
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ err: error, component: 'consumer' }, 'consumer round failed');
        await Bun.sleep(1_000);
      }
    }
  }

  private async receive(url: string): Promise<Message[]> {
    this.receiving = new AbortController();
    try {
      const { Messages = [] } = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: MAX_BATCH,
          WaitTimeSeconds: this.env.SQS_WAIT_TIME_SECONDS,
          VisibilityTimeout: this.env.SQS_VISIBILITY_TIMEOUT_SECONDS,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'SentTimestamp',
            'MessageGroupId',
          ],
        }),
        { abortSignal: this.receiving.signal },
      );
      return Messages;
    } catch (error) {
      if (!this.running) return []; // long polling abortado pelo shutdown
      throw error;
    }
  }

  /** Grupos (wallets) em paralelo; dentro do grupo, na ordem de entrega (FIFO). */
  private async processBatch(messages: Message[], urls: { main: string; dlq: string }) {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        let retryInSeconds: number | undefined;
        for (const message of group) {
          if (retryInSeconds !== undefined) {
            // FIFO: a anterior do grupo voltou para a fila; esta não pode passar na frente dela
            await this.changeVisibility(urls.main, message, retryInSeconds);
            continue;
          }
          if (!this.running) {
            // shutdown: não iniciadas voltam para a fila imediatamente
            await this.changeVisibility(urls.main, message, 0);
            continue;
          }
          retryInSeconds = await this.handle(message, urls);
        }
      }),
    );
  }

  /** Devolve o atraso, em segundos, quando a mensagem voltou para a fila (falha transitória). */
  private async handle(
    message: Message,
    urls: { main: string; dlq: string },
  ): Promise<number | undefined> {
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    const sentAt = Number.parseInt(message.Attributes?.SentTimestamp ?? '0', 10);
    if (sentAt > 0) this.metrics.queueWait(Math.max(0, (Date.now() - sentAt) / 1000));

    let envelope: WagerTransactionRequested;
    try {
      envelope = parse(message.Body);
    } catch (error) {
      const reason = error instanceof PermanentMessageError ? error.reason : 'invalid_message';
      await this.toDlq(message, urls, reason);
      return undefined;
    }

    return runWithContext<Promise<number | undefined>>(
      { correlationId: envelope.messageId, messageId: envelope.messageId },
      async () => {
        enrichContext({
          walletId: envelope.data.walletId,
          providerId: envelope.data.providerId,
        });
        try {
          this.faults.trigger('consumer.before-process');
          const { idempotencyKey, ...data } = envelope.data;
          const outcome = await this.processWager.executeFromQueue(
            { ...data, idempotencyKey },
            {
              correlationId: envelope.messageId,
              causationId: envelope.messageId,
              messageId: envelope.messageId,
              inbox: this.inboxFor(envelope),
            },
          );
          if (outcome.kind === 'inbox_payload_mismatch') {
            await this.toDlq(message, urls, 'inbox_payload_mismatch');
            return undefined;
          }
          if (outcome.kind === 'decided' || outcome.kind === 'replay') {
            enrichContext({ transactionId: outcome.result.transactionId });
          }
          // commit feito: o ack vem depois (CT-05 simula a queda exatamente aqui)
          this.faults.trigger('consumer.after-commit-before-ack');
          await this.ack(urls.main, message);
          this.logger.info({ outcome: outcome.kind, component: 'consumer' }, 'message processed');
          return undefined;
        } catch (error) {
          return this.onError(error, message, envelope, urls, receiveCount);
        }
      },
    );
  }

  private async onError(
    error: unknown,
    message: Message,
    envelope: WagerTransactionRequested,
    urls: { main: string; dlq: string },
    receiveCount: number,
  ): Promise<number | undefined> {
    if (error instanceof InjectedFaultError) throw error; // simula queda: sem ack nem visibilidade
    if (error instanceof DomainError) {
      if (error.category === 'validation') {
        await this.toDlq(message, urls, `invalid_payload:${error.code}`);
        return undefined;
      }
      if (error.category === 'permanent') {
        await this.toDlq(message, urls, `permanent:${error.code}`);
        return undefined;
      }
      if (error.category === 'business' || error.category === 'conflict') {
        // terminal: reenviar daria o mesmo resultado
        this.metrics.error({ category: error.category, failureCode: error.code });
        this.logger.warn(
          { failureCode: error.code, component: 'consumer' },
          'business rejection acked',
        );
        await this.ack(urls.main, message);
        return undefined;
      }
    } else if (isProgrammingError(error)) {
      // bug: reprocessar daria o mesmo erro — DLQ já, para um humano olhar (divergência 3)
      this.logger.error({ err: error, component: 'consumer' }, 'programming error: sent to DLQ');
      await this.toDlq(message, urls, 'bug');
      return undefined;
    }
    if (receiveCount >= this.env.SQS_MAX_RECEIVE_COUNT) {
      await this.exhausted(error, message, envelope, urls, receiveCount);
      return undefined;
    }
    // transitório (ou desconhecido): volta para a fila com backoff
    const delay = backoffSeconds(receiveCount);
    this.metrics.retry('consumer');
    this.logger.warn(
      { err: error, receiveCount, retryInSeconds: delay, component: 'consumer' },
      'transient failure: message will be retried',
    );
    await this.changeVisibility(urls.main, message, delay);
    return delay;
  }

  /**
   * Última recepção com erro transitório: registra `FAILED INFRA_RETRIES_EXHAUSTED` (§6.3) e
   * manda a mensagem à DLQ pela aplicação — assim a métrica e o alerta de DLQ a veem. Se nem o
   * registro for possível (banco fora), a mensagem vai à DLQ sem ele e pode ser reprocessada.
   */
  private async exhausted(
    error: unknown,
    message: Message,
    envelope: WagerTransactionRequested,
    urls: { main: string; dlq: string },
    receiveCount: number,
  ): Promise<void> {
    const { idempotencyKey, ...data } = envelope.data;
    try {
      const result = await this.processWager.recordQueueFailure(
        { ...data, idempotencyKey },
        {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          messageId: envelope.messageId,
          inbox: this.inboxFor(envelope),
        },
        { receiveCount, lastError: error instanceof Error ? error.name : 'unknown' },
      );
      if (result === 'already_decided') {
        // decidida por outra entrega nesse meio-tempo: o efeito já existe, só confirmar
        await this.ack(urls.main, message);
        return;
      }
      this.logger.error(
        { err: error, receiveCount, component: 'consumer', alert: 'retries_exhausted' },
        'retries exhausted: transaction recorded as FAILED',
      );
    } catch (recordError) {
      this.logger.error(
        { err: recordError, cause: error, receiveCount, component: 'consumer' },
        'retries exhausted and FAILED could not be recorded: message kept in DLQ only',
      );
    }
    await this.toDlq(message, urls, 'retries_exhausted');
  }

  private inboxFor(envelope: WagerTransactionRequested): InboxMessage {
    const now = this.clock.now();
    const inbox = InboxMessage.receive({
      messageId: envelope.messageId,
      consumerName: this.env.CONSUMER_NAME,
      // o idempotencyKey entra no hash: mesmo messageId com outra key também é anomalia (D-14)
      payloadHash: createHash('sha256')
        .update(`${canonicalJson(envelope.data)}|${envelope.data.idempotencyKey}`)
        .digest('hex'),
      receivedAt: now,
    });
    inbox.markProcessed(now); // gravada só se a transação de negócio for confirmada
    return inbox;
  }

  private async toDlq(message: Message, urls: { main: string; dlq: string }, reason: string) {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: urls.dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId || 'dlq',
        MessageDeduplicationId:
          message.MessageId ??
          createHash('sha256')
            .update(message.Body ?? '')
            .digest('hex'),
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.ack(urls.main, message);
    this.metrics.dlq(reason.split(':')[0] ?? reason);
    this.logger.warn({ reason, component: 'consumer', alert: 'dlq' }, 'message sent to DLQ');
  }

  private async ack(url: string, message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(url: string, message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      // sem visibilidade ajustada, a mensagem volta sozinha quando o timeout vencer
      this.logger.warn(
        { err: error, component: 'consumer' },
        'could not change message visibility',
      );
    }
  }

  private async resolveUrls(): Promise<{ main: string; dlq: string }> {
    if (this.urls) return this.urls;
    const [main, dlq] = await Promise.all([
      queueUrl(this.sqs, this.env.SQS_WAGER_QUEUE),
      queueUrl(this.sqs, this.env.SQS_WAGER_DLQ),
    ]);
    if (!main || !dlq) throw new Error('filas de transações ainda não existem');
    this.urls = { main, dlq };
    return this.urls;
  }
}

function parse(body: string | undefined): WagerTransactionRequested {
  let json: unknown;
  try {
    json = JSON.parse(body ?? '');
  } catch {
    throw new PermanentMessageError('malformed_json');
  }
  const result = WagerTransactionRequestedMessage.safeParse(json);
  if (!result.success) {
    const unknownType =
      typeof json === 'object' &&
      json !== null &&
      (json as { type?: unknown }).type !== 'WagerTransactionRequested';
    throw new PermanentMessageError(unknownType ? 'unknown_type' : 'invalid_schema');
  }
  return result.data;
}

/**
 * Erro de programação: reprocessar daria o mesmo resultado. Erros de sistema (com `code`, como
 * os de rede do driver) ficam de fora — esses podem ser transitórios.
 */
function isProgrammingError(error: unknown): boolean {
  if (error instanceof InvariantViolationError) return true;
  const isJsBug =
    error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError;
  return isJsBug && !(error as { code?: unknown }).code;
}

/** 2ⁿ s com teto de 5 min e jitter de até 20% (docs/03 §9.1). */
function backoffSeconds(receiveCount: number): number {
  const base = Math.min(2 ** receiveCount, MAX_BACKOFF_SECONDS);
  return Math.min(MAX_BACKOFF_SECONDS, Math.ceil(base * (1 + Math.random() * 0.2)));
}
