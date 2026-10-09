import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createOrmConfig } from '../../src/database/mikro-orm.config';
import { createApp } from '../../src/main';
import { ensureQueues, queueUrl } from '../../src/shared/infrastructure/sqs/queues';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.module';
import { startTestEnvironment, type TestEnvironment } from './support/environment';

let infra: TestEnvironment;

beforeAll(async () => {
  infra = await startTestEnvironment();
});

afterAll(async () => {
  await infra?.stop();
});

describe('migrations (IT-01)', () => {
  const functionExists = async (orm: MikroORM): Promise<boolean> => {
    const rows = await orm.em
      .getConnection()
      .execute<{ count: string }[]>(
        "SELECT count(*) AS count FROM pg_proc WHERE proname = 'forbid_mutation'",
      );
    return rows[0]?.count === '1';
  };

  it('aplica, reverte e reaplica sem erro', async () => {
    const orm = await MikroORM.init(createOrmConfig(infra.env));
    try {
      const migrator = orm.getMigrator();

      expect((await migrator.up()).length).toBeGreaterThan(0);
      expect(await functionExists(orm)).toBe(true);
      expect(await migrator.getPendingMigrations()).toHaveLength(0);

      await migrator.down({ to: 0 });
      expect(await functionExists(orm)).toBe(false);

      await migrator.up();
      expect(await functionExists(orm)).toBe(true);
    } finally {
      await orm.close(true);
    }
  });
});

describe('topologia de filas', () => {
  let sqs: SQSClient;

  beforeAll(() => {
    sqs = createSqsClient(infra.env);
  });
  afterAll(() => sqs.destroy());

  it('cria as três filas FIFO e é idempotente', async () => {
    await ensureQueues(sqs, infra.env);
    await ensureQueues(sqs, infra.env);

    for (const name of [
      infra.env.SQS_WAGER_QUEUE,
      infra.env.SQS_WAGER_DLQ,
      infra.env.SQS_EVENTS_QUEUE,
    ]) {
      expect(await queueUrl(sqs, name)).toBeDefined();
    }
  });

  it('liga a fila principal à DLQ com o limite de tentativas configurado', async () => {
    const mainUrl = await queueUrl(sqs, infra.env.SQS_WAGER_QUEUE);
    const dlqUrl = await queueUrl(sqs, infra.env.SQS_WAGER_DLQ);

    const { Attributes: main } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: mainUrl, AttributeNames: ['All'] }),
    );
    const { Attributes: dlq } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
    );

    expect(main?.FifoQueue).toBe('true');
    const redrive = JSON.parse(main?.RedrivePolicy ?? '{}');
    expect(redrive.deadLetterTargetArn).toBe(dlq?.QueueArn);
    expect(Number(redrive.maxReceiveCount)).toBe(infra.env.SQS_MAX_RECEIVE_COUNT);
  });
});

describe('aplicação: health e correlação (IT-21)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const sqs = createSqsClient(infra.env);
    await ensureQueues(sqs, infra.env);
    sqs.destroy();

    app = await createApp(infra.env);
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/live responde 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'up' });
  });

  it('GET /health/ready responde 200 com Postgres e SQS alcançáveis', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'up', checks: { postgres: 'up', sqs: 'up' } });
  });

  it('propaga um X-Correlation-Id válido e gera um quando ausente ou inválido', async () => {
    const echoed = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'corr-123' },
    });
    expect(echoed.headers.get('x-correlation-id')).toBe('corr-123');

    const generated = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'inválido com espaços' },
    });
    expect(generated.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  // por último: derruba o Postgres
  it('GET /health/ready responde 503 quando o Postgres cai, e /live continua 200', async () => {
    await infra.postgres.stop();

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: 'down',
      checks: { postgres: 'down', sqs: 'up' },
    });

    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });
});
