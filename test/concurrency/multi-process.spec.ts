import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import { ensureQueues } from '../../src/shared/infrastructure/sqs/queues';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.module';
import { assertLedgerConsistency, connect, migrate } from '../integration/support/database';
import { startTestEnvironment, type TestEnvironment } from '../integration/support/environment';
import { envelope, queueDepth, sendRaw, urlOf, waitFor } from '../integration/support/queues';
import { brl, createWallet, submit, type TestWallet, wager } from '../integration/support/wagering';
import { ALL_ROLES, FAST_WORKERS, type Instance, spawnInstance } from './support/processes';

let infra: TestEnvironment;
let sql: SQL;
let sqs: SQSClient;
let mainUrl: string;
let eventsUrl: string;
const running: Instance[] = [];

beforeAll(async () => {
  infra = await startTestEnvironment();
  await migrate(infra.env);
  sqs = createSqsClient(infra.env);
  await ensureQueues(sqs, infra.env);
  sql = connect(infra.env);
  mainUrl = await urlOf(sqs, infra.env.SQS_WAGER_QUEUE);
  eventsUrl = await urlOf(sqs, infra.env.SQS_EVENTS_QUEUE);
});

// cada teste começa sem instâncias vivas: uma sobra consumiria as mensagens do próximo
afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.stop('SIGKILL')));
});

afterAll(async () => {
  sqs?.destroy();
  await sql?.close();
  await infra?.stop();
});

async function spawn(name: string, overrides: Record<string, string> = {}, waitReady = true) {
  const instance = await spawnInstance(
    infra.env,
    name,
    { ...FAST_WORKERS, ...overrides },
    waitReady,
  );
  running.push(instance);
  return instance;
}

const sendMessage = (body: unknown, wallet: TestWallet) =>
  sendRaw(sqs, mainUrl, JSON.stringify(body), wallet.walletId);

async function count(query: Promise<{ n: number }[]>) {
  const [row] = await query;
  return row?.n ?? 0;
}

const outboxPending = () =>
  count(sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`);

describe('múltiplos processos reais (§8, §13)', () => {
  it('CT-04/CT-09 hot wallet com 3 instâncias: HTTP + SQS + duplicatas, um débito por operação', async () => {
    const instances = await Promise.all(['p1', 'p2', 'p3'].map((n) => spawn(n, ALL_ROLES)));
    const wallet = await createWallet(instances[0]?.url ?? '', '1000.00');

    // 150 BETs via HTTP, cada uma enviada a DUAS instâncias diferentes, tudo em paralelo
    const httpBets = Array.from({ length: 150 }, (_, i) =>
      wager(wallet, {
        externalTransactionId: `http-${i}`,
        gameId: `g${i % 7}`,
        money: brl('10.00'),
      }),
    );
    // 50 BETs via SQS, cada mensagem entregue duas vezes (mesmo messageId)
    const queued = Array.from({ length: 50 }, (_, i) =>
      envelope(wager(wallet, { externalTransactionId: `sqs-${i}`, money: brl('10.00') })),
    );

    const responses = await Promise.all([
      ...httpBets.flatMap((body, i) => [
        submit(instances[i % 3]?.url ?? '', body),
        submit(instances[(i + 1) % 3]?.url ?? '', body),
      ]),
      ...queued.flatMap((message) => [sendMessage(message, wallet), sendMessage(message, wallet)]),
    ]);
    const statuses = responses
      .filter((r): r is Awaited<ReturnType<typeof submit>> => typeof r === 'object' && r !== null)
      .map((r) => r.status);
    expect(statuses.every((s) => [200, 201, 422].includes(s))).toBe(true);

    await waitFor(
      async () =>
        (await count(sql`
          SELECT count(*)::int AS n FROM wager_transactions
           WHERE wallet_id = ${wallet.walletId} AND kind = 'BET'`)) === 200 &&
        (await queueDepth(sqs, mainUrl)) === 0,
      60_000,
    );

    // saldo 1000 / 10 = exatamente 100 aprovadas entre 200 operações distintas
    const [summary] = await sql`
      SELECT balance::text AS balance,
             (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${wallet.walletId}
                AND kind = 'BET' AND status = 'PROCESSED') AS processed,
             (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${wallet.walletId}
                AND kind = 'BET' AND status = 'REJECTED') AS rejected,
             (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}
                AND direction = 'DEBIT') AS debits,
             (SELECT count(DISTINCT instance_id)::int FROM wager_transaction_audit
               WHERE wallet_id = ${wallet.walletId} AND source = 'HTTP') AS deciding_instances
        FROM wallets WHERE id = ${wallet.walletId}`;
    expect(summary).toEqual({
      balance: '0.00',
      processed: 100,
      rejected: 100,
      debits: 100,
      deciding_instances: 3,
    });
    await assertLedgerConsistency(sql, wallet.walletId);

    // deciding_instances: as 3 instâncias decidiram (aprovar, rejeitar ou replay) requisições
    // todas as instâncias publicam a outbox: nada fica para trás
    await waitFor(async () => (await outboxPending()) === 0, 30_000);
    await Promise.all(instances.map((instance) => instance.stop('SIGTERM')));
  });

  it('CT-05 consumidor recebe SIGKILL depois do commit e antes do ack: um único efeito', async () => {
    const api = await spawn('api-05', { APP_ROLE: 'api' });
    const wallet = await createWallet(api.url, '100.00');
    await sendMessage(envelope(wager(wallet, { money: brl('40.00') })), wallet);

    const victim = await spawn(
      'consumer-killed',
      {
        APP_ROLE: 'consumer',
        FAULT_POINTS: 'consumer.after-commit-before-ack:kill',
      },
      false,
    );
    expect((await victim.exited()).signalCode).toBe('SIGKILL');

    const committed = await count(sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ${wallet.walletId} AND kind = 'BET'`);
    expect(committed).toBe(1);
    expect(await queueDepth(sqs, mainUrl)).toBe(1); // sem ack

    const survivor = await spawn('consumer-survivor', { APP_ROLE: 'consumer' });
    await waitFor(async () => (await queueDepth(sqs, mainUrl)) === 0, 30_000);
    const metrics = await (await fetch(`${survivor.url}/metrics`)).text();
    expect(metrics).toMatch(/type="inbox_duplicate"\} 1/);

    const [row] =
      await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row.balance).toBe('60.00');
    await assertLedgerConsistency(sql, wallet.walletId);
    await Promise.all([api.stop(), survivor.stop()]);
  });

  it('CT-06 publisher recebe SIGKILL depois de publicar: dois sobreviventes concluem sem perda', async () => {
    await drainEvents();
    const api = await spawn('api-06', { APP_ROLE: 'api' });
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(api.url, '10.00')),
    );
    const walletIds = wallets.map((w) => w.walletId);
    const expected = (
      await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`
    ).map((r: { id: string }) => r.id);
    expect(expected).toHaveLength(40);

    const victim = await spawn(
      'publisher-killed',
      {
        APP_ROLE: 'outbox',
        OUTBOX_BATCH_SIZE: '5',
        FAULT_POINTS: 'outbox.after-publish-before-mark:kill',
      },
      false,
    );
    expect((await victim.exited()).signalCode).toBe('SIGKILL');

    const survivors = await Promise.all([
      spawn('publisher-a', { APP_ROLE: 'outbox', OUTBOX_BATCH_SIZE: '5' }),
      spawn('publisher-b', { APP_ROLE: 'outbox', OUTBOX_BATCH_SIZE: '5' }),
    ]);
    await waitFor(async () => (await outboxPending()) === 0, 30_000);

    const received = (await drainEvents()).filter((e) => walletIds.includes(e.aggregateId));
    const unique = new Set(received.map((e) => e.eventId));
    expect([...unique].sort()).toEqual(expected.sort()); // nenhum evento perdido
    await Promise.all([api.stop(), ...survivors.map((s) => s.stop())]);
  });

  it('CT-08 todas as instâncias morrem (SIGKILL) no meio da carga; após reiniciar, consistência total', async () => {
    let instances = await Promise.all(['r1', 'r2', 'r3'].map((n) => spawn(n, ALL_ROLES)));
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createWallet(instances[i % 3]?.url ?? '', '100.00')),
    );
    const httpOps = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, (_, i) =>
        wager(wallet, {
          externalTransactionId: `r-http-${wallet.walletId}-${i}`,
          money: brl('1.00'),
        }),
      ),
    );
    const queueOps = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, (_, i) => ({
        wallet,
        message: envelope(
          wager(wallet, {
            externalTransactionId: `r-sqs-${wallet.walletId}-${i}`,
            money: brl('1.00'),
          }),
        ),
      })),
    );

    // carga em andamento… e todos os processos morrem de uma vez
    const inFlight = Promise.allSettled(
      httpOps.map((body, i) => submit(instances[i % 3]?.url ?? '', body)),
    );
    for (const op of queueOps) await sendMessage(op.message, op.wallet);
    await Bun.sleep(150);
    await Promise.all(instances.map((instance) => instance.stop('SIGKILL')));
    await inFlight;

    // reinício: novas instâncias; o cliente reenvia o HTTP (idempotente), a fila é reentregue
    instances = await Promise.all(['r4', 'r5', 'r6'].map((n) => spawn(n, ALL_ROLES)));
    await Promise.all(httpOps.map((body, i) => submit(instances[i % 3]?.url ?? '', body)));
    await waitFor(
      async () =>
        (await queueDepth(sqs, mainUrl)) === 0 &&
        (await outboxPending()) === 0 &&
        (await count(sql`
          SELECT count(*)::int AS n FROM wager_transactions
           WHERE external_transaction_id LIKE 'r-%' AND kind = 'BET'`)) === 100,
      60_000,
    );

    // cada operação exatamente uma vez, nenhuma mensagem perdida, saldo e ledger coerentes
    const [dupes] = await sql`
      SELECT count(*)::int AS n FROM (
        SELECT external_transaction_id FROM wager_transactions
         WHERE external_transaction_id LIKE 'r-%' GROUP BY 1 HAVING count(*) > 1) d`;
    expect(dupes.n).toBe(0);
    for (const wallet of wallets) {
      const [row] =
        await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
      expect(row.balance).toBe('90.00');
      await assertLedgerConsistency(sql, wallet.walletId);
      const reconciliation = await fetch(
        `${instances[0]?.url}/wallets/${wallet.walletId}/reconciliation`,
        { method: 'POST' },
      ).then((r) => r.json() as Promise<{ consistent: boolean }>);
      expect(reconciliation.consistent).toBe(true);
    }
    await Promise.all(instances.map((instance) => instance.stop('SIGTERM')));
  });

  it('SIGTERM real: o processo encerra com código 0 e o que ficou na fila é processado depois', async () => {
    const api = await spawn('api-term', { APP_ROLE: 'api' });
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(api.url, '50.00')),
    );
    for (const wallet of wallets) {
      await sendMessage(envelope(wager(wallet, { money: brl('20.00') })), wallet);
    }
    const processed = () =>
      count(sql`
        SELECT count(*)::int AS n FROM wager_transactions
         WHERE wallet_id IN ${sql(wallets.map((w) => w.walletId))} AND kind = 'BET'`);

    const first = await spawn('consumer-term', { APP_ROLE: 'consumer' });
    await waitFor(async () => (await processed()) >= 1);
    const startedAt = Date.now();
    // NestJS (enableShutdownHooks) roda o encerramento gracioso e depois re-emite o SIGTERM:
    // o processo termina "por sinal" — o que prova o gracioso é o log de drenagem concluída
    expect(await first.stop('SIGTERM')).toEqual({ exitCode: null, signalCode: 'SIGTERM' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(first.logs.join('')).toContain('graceful shutdown complete');

    const second = await spawn('consumer-term-2', { APP_ROLE: 'consumer' });
    await waitFor(async () => (await processed()) === 10 && (await queueDepth(sqs, mainUrl)) === 0);
    for (const wallet of wallets) await assertLedgerConsistency(sql, wallet.walletId);
    await Promise.all([api.stop(), second.stop()]);
  });
});

async function drainEvents(): Promise<{ eventId: string; aggregateId: string }[]> {
  const { DeleteMessageCommand, ReceiveMessageCommand } = await import('@aws-sdk/client-sqs');
  const out: { eventId: string; aggregateId: string }[] = [];
  let empty = 0;
  while (empty < 2) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    if (Messages.length === 0) empty += 1;
    for (const message of Messages) {
      const body = JSON.parse(message.Body ?? '{}');
      out.push({ eventId: body.eventId, aggregateId: body.aggregateId });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return out;
}
