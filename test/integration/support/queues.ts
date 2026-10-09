import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { queueUrl } from '../../../src/shared/infrastructure/sqs/queues';
import { uuid } from './database';
import type { WagerBody } from './wagering';

export async function urlOf(sqs: SQSClient, name: string): Promise<string> {
  const url = await queueUrl(sqs, name);
  if (!url) throw new Error(`fila ${name} inexistente`);
  return url;
}

/** Envelope do §10. `idempotencyKey` padrão: `{providerId}:{externalTransactionId}`. */
export function envelope(data: WagerBody, overrides: { messageId?: string; type?: string } = {}) {
  return {
    messageId: overrides.messageId ?? `msg-${uuid()}`,
    type: overrides.type ?? 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  };
}

/** Envia com deduplicação do SQS única: reentregas são intencionais nos testes. */
export async function sendRaw(sqs: SQSClient, url: string, body: string, groupId: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: uuid(),
    }),
  );
}

export async function queueDepth(sqs: SQSClient, url: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

export interface DlqMessage {
  reason: string | undefined;
  body: string;
}

/** Lê e remove o conteúdo atual da DLQ. */
export async function drainDlq(sqs: SQSClient, url: string): Promise<DlqMessage[]> {
  const out: DlqMessage[] = [];
  let empty = 0;
  while (empty < 2) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    if (Messages.length === 0) empty += 1;
    for (const message of Messages) {
      out.push({
        reason: message.MessageAttributes?.reason?.StringValue,
        body: message.Body ?? '',
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return out;
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`condição não atingida em ${timeoutMs} ms`);
}
