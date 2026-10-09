import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import type { Env } from '../../src/config/env';
import { queueUrl } from '../../src/shared/infrastructure/sqs/queues';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.module';
import { type RunningApp, startApp } from './support/app';
import { connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { createWallet } from './support/wagering';

let infra: TestEnvironment;
let api: RunningApp;
let sql: SQL;
let sqs: SQSClient;

beforeAll(async () => {
  infra = await startTestEnvironment();
  api = await startApp(infra.env); // APP_ROLE=api: grava eventos, não publica
  sql = connect(infra.env);
  sqs = createSqsClient(infra.env);
});

afterAll(async () => {
  sqs?.destroy();
  await sql?.close();
  await api?.close();
  await infra?.stop();
});

/** Publisher isolado (APP_ROLE=outbox) com varredura rápida para testes. */
function startPublisher(overrides: Partial<Record<keyof Env, string>> = {}) {
  return startApp(
    {
      ...infra.env,
      APP_ROLE: ['outbox'],
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_BATCH_SIZE: 10,
      ...coerce(overrides),
    } as Env,
    { skipSetup: true },
  );
}

function coerce(overrides: Partial<Record<keyof Env, string>>): Partial<Env> {
  const numeric = new Set(['OUTBOX_POLL_INTERVAL_MS', 'OUTBOX_BATCH_SIZE', 'OUTBOX_LEASE_MS']);
  return Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [
      key,
      numeric.has(key) ? Number(value) : value,
    ]),
  ) as Partial<Env>;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`condição não atingida em ${timeoutMs} ms`);
}

async function pendingFor(walletIds: string[]): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM outbox_messages
     WHERE aggregate_id IN ${sql(walletIds)} AND published_at IS NULL`;
  return row.n;
}

async function outboxIdsFor(walletIds: string[]): Promise<string[]> {
  const rows = await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`;
  return rows.map((r: { id: string }) => r.id).sort();
}

interface Received {
  eventId: string;
  eventType: string;
  aggregateId: string;
  groupId: string | undefined;
  dedupId: string | undefined;
  body: Record<string, unknown>;
}

/** Lê (e remove) tudo o que estiver na fila de eventos. */
async function drainEvents(queue = infra.env.SQS_EVENTS_QUEUE): Promise<Received[]> {
  const url = await queueUrl(sqs, queue);
  if (!url) throw new Error(`fila ${queue} inexistente`);
  const received: Received[] = [];
  let emptyPolls = 0;
  while (emptyPolls < 2) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length === 0) emptyPolls += 1;
    for (const message of Messages) {
      const body = JSON.parse(message.Body ?? '{}');
      received.push({
        eventId: body.eventId,
        eventType: body.eventType,
        aggregateId: body.aggregateId,
        groupId: message.Attributes?.MessageGroupId,
        dedupId: message.Attributes?.MessageDeduplicationId,
        body,
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return received;
}

const walletsWithEvents = async (count: number) =>
  Promise.all(Array.from({ length: count }, () => createWallet(api.url, '10.00')));

describe('Transactional Outbox (§11)', () => {
  it('IT-18 eventos gravados com o publisher parado são publicados quando ele sobe', async () => {
    await drainEvents();
    const wallets = await walletsWithEvents(5);
    const walletIds = wallets.map((w) => w.walletId);
    expect(await pendingFor(walletIds)).toBe(10); // 2 eventos por wallet (OPENING)

    const publisher = await startPublisher();
    try {
      await waitFor(async () => (await pendingFor(walletIds)) === 0);
    } finally {
      await publisher.close();
    }

    const events = (await drainEvents()).filter((e) => walletIds.includes(e.aggregateId));
    expect(events.map((e) => e.eventId).sort()).toEqual(await outboxIdsFor(walletIds));
    for (const event of events) {
      expect(event.groupId).toBe(event.aggregateId); // ordem por wallet
      expect(event.dedupId).toBe(event.eventId); // dedup por evento
      expect(event.body).toMatchObject({ version: 1, correlationId: expect.any(String) });
    }
  });

  it('IT-16 dois publishers concorrentes: nenhum evento perdido nem publicado duas vezes', async () => {
    await drainEvents();
    const wallets = await walletsWithEvents(30);
    const walletIds = wallets.map((w) => w.walletId);

    const [a, b] = await Promise.all([
      startPublisher({ OUTBOX_BATCH_SIZE: '3' }),
      startPublisher({ OUTBOX_BATCH_SIZE: '3' }),
    ]);
    try {
      await waitFor(async () => (await pendingFor(walletIds)) === 0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }

    const ids = (await drainEvents())
      .filter((e) => walletIds.includes(e.aggregateId))
      .map((e) => e.eventId);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(ids.sort()).toEqual(await outboxIdsFor(walletIds));
  });

  it('IT-17 SQS indisponível: retry com backoff e publicação quando volta', async () => {
    const missingQueue = `events-${crypto.randomUUID().slice(0, 8)}.fifo`;
    const publisher = await startPublisher({ SQS_EVENTS_QUEUE: missingQueue });
    try {
      const [wallet] = await walletsWithEvents(1);
      const walletIds = [wallet?.walletId ?? ''];

      await waitFor(async () => {
        const [row] = await sql`
          SELECT min(attempts)::int AS attempts, bool_and(published_at IS NULL) AS pending,
                 bool_and(next_attempt_at > occurred_at) AS backed_off, bool_and(locked_by IS NULL) AS released
            FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`;
        return row.attempts >= 1 && row.pending && row.backed_off && row.released;
      });
      const metrics = await (await fetch(`${publisher.url}/metrics`)).text();
      expect(metrics).toMatch(/wagering_retries_total\{component="outbox"\} [1-9]/);

      // o "SQS volta": a fila passa a existir e o próximo retry publica
      await sqs.send(
        new CreateQueueCommand({ QueueName: missingQueue, Attributes: { FifoQueue: 'true' } }),
      );
      await waitFor(async () => (await pendingFor(walletIds)) === 0);
      const events = (await drainEvents(missingQueue)).filter((e) =>
        walletIds.includes(e.aggregateId),
      );
      expect(events).toHaveLength(2);
    } finally {
      await publisher.close();
    }
  });

  it('processo morre depois de publicar e antes de marcar: outra instância assume após o lease', async () => {
    await drainEvents();
    const crashing = await startPublisher({
      FAULT_POINTS: 'outbox.after-publish-before-mark',
      OUTBOX_LEASE_MS: '1000',
    });
    const [wallet] = await walletsWithEvents(1);
    const walletIds = [wallet?.walletId ?? ''];
    try {
      // publicou no SQS, mas o "crash" impediu de marcar: continua pendente e com lease
      await waitFor(async () => {
        const [row] = await sql`
          SELECT bool_and(locked_by IS NOT NULL) AS leased, bool_and(published_at IS NULL) AS pending
            FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`;
        return row.leased && row.pending;
      });
    } finally {
      await crashing.close();
    }

    const survivor = await startPublisher({ OUTBOX_LEASE_MS: '1000' });
    try {
      await waitFor(async () => (await pendingFor(walletIds)) === 0);
    } finally {
      await survivor.close();
    }

    const events = (await drainEvents()).filter((e) => walletIds.includes(e.aggregateId));
    const unique = new Set(events.map((e) => e.eventId));
    expect([...unique].sort()).toEqual(await outboxIdsFor(walletIds)); // nada perdido
    // republicação é segura: mesmo eventId (o SQS FIFO deduplica na janela de 5 min)
    expect(events.length).toBeGreaterThanOrEqual(unique.size);
  });

  it('expõe outbox lag e eventos publicados', async () => {
    const publisher = await startPublisher();
    try {
      await walletsWithEvents(1);
      await Bun.sleep(500);
      const metrics = await (await fetch(`${publisher.url}/metrics`)).text();
      expect(metrics).toContain('wagering_outbox_lag_seconds');
      expect(metrics).toMatch(/wagering_outbox_published_total [1-9]/);
    } finally {
      await publisher.close();
    }
  });
});
