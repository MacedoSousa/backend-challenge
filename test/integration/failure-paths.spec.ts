import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import type { Env } from '../../src/config/env';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.module';
import { type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { drainDlq, envelope, queueDepth, sendRaw, urlOf, waitFor } from './support/queues';
import { brl, createWallet, submit, wager } from './support/wagering';

let infra: TestEnvironment;
let api: RunningApp;
let sql: SQL;
let sqs: SQSClient;

beforeAll(async () => {
  infra = await startTestEnvironment();
  // lock_timeout curto para provar o 503 sem esperar 5 s
  api = await startApp({ ...infra.env, DB_LOCK_TIMEOUT_MS: 300 } as Env);
  sql = connect(infra.env);
  sqs = createSqsClient(infra.env);
});

afterAll(async () => {
  sqs?.destroy();
  await sql?.close();
  await api?.close();
  await infra?.stop();
});

const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

describe('caminhos de falha e corrida (§9, §3)', () => {
  it('lock da wallet esgotado → 503 INFRA_UNAVAILABLE com Retry-After; o reenvio idêntico aplica 1×', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const body = wager(wallet, { money: brl('10.00') });

    let release: () => void = () => {};
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    // garante que o lock já foi adquirido antes da requisição
    await waitFor(
      async () =>
        (await count(sql`
        SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
         WHERE c.relname = 'wallets' AND l.mode = 'RowShareLock' AND l.granted`)) > 0,
    );

    const blocked = await submit(api.url, body);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('retry-after')).toBe('1');
    expect(blocked.body).toMatchObject({ failureCode: 'INFRA_UNAVAILABLE', status: 503 });

    release();
    await holder;
    // o provedor reenvia com a mesma Idempotency-Key: seguro, aplica uma única vez
    const retried = await submit(api.url, body);
    expect(retried.status).toBe(201);
    expect(retried.body.balance).toEqual(brl('90.00'));

    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_lock_timeouts_total [1-9]/);
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('mesma Idempotency-Key ao mesmo tempo em wallets diferentes: uma vence, a outra é conflito', async () => {
    for (let round = 0; round < 10; round += 1) {
      const [a, b] = await Promise.all([
        createWallet(api.url, '50.00'),
        createWallet(api.url, '50.00'),
      ]);
      if (!a || !b) throw new Error('wallets');
      const externalTransactionId = `race-${crypto.randomUUID()}`;
      // locks em wallets distintas: quem desempata é o UNIQUE do banco + releitura
      const results = await Promise.all([
        submit(api.url, wager(a, { externalTransactionId, money: brl('5.00') })),
        submit(api.url, wager(b, { externalTransactionId, money: brl('5.00') })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await count(sql`
          SELECT count(*)::int AS n FROM wager_transactions
           WHERE external_transaction_id = ${externalTransactionId}`),
      ).toBe(1);
      await assertLedgerConsistency(sql, a.walletId);
      await assertLedgerConsistency(sql, b.walletId);
    }
  });

  it('conflito de idempotência pela fila: ack, auditado, sem DLQ, e o provedor recebe WagerOperationRejected', async () => {
    const mainUrl = await urlOf(sqs, infra.env.SQS_WAGER_QUEUE);
    const dlqUrl = await urlOf(sqs, infra.env.SQS_WAGER_DLQ);
    await drainDlq(sqs, dlqUrl);
    const wallet = await createWallet(api.url, '100.00');
    const original = envelope(wager(wallet, { money: brl('10.00') }));
    // outra mensagem (outro messageId) com a mesma operação e outro valor
    const conflicting = {
      ...original,
      messageId: `msg-${crypto.randomUUID()}`,
      data: { ...original.data, money: brl('11.00') },
    };
    await sendRaw(sqs, mainUrl, JSON.stringify(original), wallet.walletId);
    await sendRaw(sqs, mainUrl, JSON.stringify(conflicting), wallet.walletId);

    const consumer = await startApp(
      {
        ...infra.env,
        APP_ROLE: ['consumer'],
        SQS_WAIT_TIME_SECONDS: 1,
        SQS_VISIBILITY_TIMEOUT_SECONDS: 2,
      } as Env,
      { skipSetup: true },
    );
    try {
      await waitFor(async () => (await queueDepth(sqs, mainUrl)) === 0);
    } finally {
      await consumer.close();
    }

    expect(await drainDlq(sqs, dlqUrl)).toEqual([]);
    const [audit] = await sql`
      SELECT a.failure_code, a.source, a.message_id FROM wager_transaction_audit a
        JOIN wager_transactions t ON t.id = a.transaction_id
       WHERE t.wallet_id = ${wallet.walletId} AND a.action = 'IDEMPOTENCY_CONFLICT'`;
    expect(audit).toEqual({
      failure_code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      source: 'SQS',
      message_id: conflicting.messageId,
    });
    const [row] =
      await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row.balance).toBe('90.00');

    // pela fila não há resposta 409: o provedor é avisado por evento (docs/08, div. 5)
    const [event] = await sql`
      SELECT payload->'data' AS data FROM outbox_messages
       WHERE event_type = 'WagerOperationRejected'
         AND payload->'data'->>'messageId' = ${conflicting.messageId}`;
    expect(event.data.failureCode).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(event.data.externalTransactionId).toBe(original.data.externalTransactionId);
    const [stored] = await sql`
      SELECT id FROM wager_transactions WHERE wallet_id = ${wallet.walletId} AND kind = 'BET'`;
    expect(event.data.originalTransactionId).toBe(stored.id);
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  // por último: derruba o Postgres
  it('banco fora do ar → 503 INFRA_UNAVAILABLE com Retry-After (nunca 500)', async () => {
    const wallet = await createWallet(api.url, '100.00');
    await infra.postgres.stop();

    const res = await submit(api.url, wager(wallet));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.body.failureCode).toBe('INFRA_UNAVAILABLE');
  });
});
