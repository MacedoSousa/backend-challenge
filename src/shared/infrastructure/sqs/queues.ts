import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Env } from '../../../config/env';

type QueueEnv = Pick<
  Env,
  'SQS_WAGER_QUEUE' | 'SQS_WAGER_DLQ' | 'SQS_EVENTS_QUEUE' | 'SQS_MAX_RECEIVE_COUNT'
>;

const FIFO_ATTRIBUTES = {
  FifoQueue: 'true',
  // a deduplicação é de conteúdo explícito (MessageDeduplicationId); o banco é a garantia final
  ContentBasedDeduplication: 'false',
} as const;

/** Visibilidade inicial; o consumidor ajusta por mensagem com backoff. */
const VISIBILITY_TIMEOUT_SECONDS = '60';
const RETENTION_SECONDS = String(14 * 24 * 60 * 60);

/**
 * Fonte única da topologia de filas: usada pelo setup do Compose e pelos testes.
 * Idempotente: CreateQueue com os mesmos atributos devolve a fila existente.
 */
export async function ensureQueues(client: SQSClient, env: QueueEnv): Promise<void> {
  const dlqUrl = await createQueue(client, env.SQS_WAGER_DLQ, {
    ...FIFO_ATTRIBUTES,
    MessageRetentionPeriod: RETENTION_SECONDS,
  });
  const dlqArn = await queueArn(client, dlqUrl);

  await createQueue(client, env.SQS_WAGER_QUEUE, {
    ...FIFO_ATTRIBUTES,
    VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
    MessageRetentionPeriod: RETENTION_SECONDS,
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
    }),
  });

  await createQueue(client, env.SQS_EVENTS_QUEUE, {
    ...FIFO_ATTRIBUTES,
    MessageRetentionPeriod: RETENTION_SECONDS,
  });
}

export async function queueUrl(client: SQSClient, name: string): Promise<string | undefined> {
  try {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    return QueueUrl;
  } catch (error) {
    if (error instanceof QueueDoesNotExist) return undefined;
    throw error;
  }
}

async function createQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (!QueueUrl) throw new Error(`SQS não retornou a URL da fila ${name}`);
  return QueueUrl;
}

async function queueArn(client: SQSClient, url: string): Promise<string> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  const arn = Attributes?.QueueArn;
  if (!arn) throw new Error(`SQS não retornou o ARN da fila ${url}`);
  return arn;
}
