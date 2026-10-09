import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import type { Env } from '../../src/config/env';
import { createSqsClient } from '../../src/shared/infrastructure/sqs/sqs.module';
import { type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { drainDlq, envelope, queueDepth, sendRaw, urlOf, waitFor } from './support/queues';
import { brl, createWallet, type TestWallet, wager } from './support/wagering';

let infra: TestEnvironment;
let api: RunningApp;
let sql: SQL;
let sqs: SQSClient;
let mainUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  // redrive rápido para os testes: DLQ após 2 recebimentos
  infra = await startTestEnvironment({ SQS_MAX_RECEIVE_COUNT: '2' });
  api = await startApp(infra.env);
  sql = connect(infra.env);
  sqs = createSqsClient(infra.env);
  mainUrl = await urlOf(sqs, infra.env.SQS_WAGER_QUEUE);
  dlqUrl = await urlOf(sqs, infra.env.SQS_WAGER_DLQ);
});

afterAll(async () => {
  sqs?.destroy();
  await sql?.close();
  await api?.close();
  await infra?.stop();
});

function startConsumer(overrides: Partial<Env> = {}) {
  return startApp(
    {
      ...infra.env,
      APP_ROLE: ['consumer'],
      SQS_WAIT_TIME_SECONDS: 1,
      SQS_VISIBILITY_TIMEOUT_SECONDS: 2,
      ...overrides,
    } as Env,
    { skipSetup: true },
  );
}

async function withConsumer<T>(
  fn: (consumer: RunningApp) => Promise<T>,
  overrides: Partial<Env> = {},
) {
  const consumer = await startConsumer(overrides);
  try {
    return await fn(consumer);
  } finally {
    await consumer.close();
  }
}

const send = (body: unknown, wallet: TestWallet) =>
  sendRaw(sqs, mainUrl, typeof body === 'string' ? body : JSON.stringify(body), wallet.walletId);

async function transactionsOf(wallet: TestWallet) {
  return sql`
    SELECT id, external_transaction_id, status, failure_code FROM wager_transactions
     WHERE wallet_id = ${wallet.walletId} AND kind <> 'OPENING' ORDER BY created_at`;
}

const drained = () => queueDepth(sqs, mainUrl).then((n) => n === 0);

describe('consumidor SQS (§10)', () => {
  it('processa pelo mesmo use case da API, grava inbox e faz ack após o commit', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const message = envelope(wager(wallet, { money: brl('30.00') }));
    await send(message, wallet);

    await withConsumer(async () => {
      await waitFor(async () => (await transactionsOf(wallet)).length === 1 && (await drained()));
    });

    const [tx] = await transactionsOf(wallet);
    expect(tx.status).toBe('PROCESSED');
    const [audit] = await sql`
      SELECT source, message_id, correlation_id FROM wager_transaction_audit WHERE transaction_id = ${tx.id}`;
    expect(audit).toEqual({
      source: 'SQS',
      message_id: message.messageId,
      correlation_id: message.messageId,
    });
    const [inbox] = await sql`
      SELECT consumer_name, processed_at IS NOT NULL AS processed FROM inbox_messages
       WHERE message_id = ${message.messageId}`;
    expect(inbox).toEqual({ consumer_name: 'wager-transactions', processed: true });
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('IT-12 reentrega da mesma mensagem: inbox detecta, um único efeito', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const message = envelope(wager(wallet, { money: brl('30.00') }));
    await send(message, wallet);
    await send(message, wallet);
    // mesma operação com outro messageId: idempotência (replay), não inbox
    await send({ ...message, messageId: `msg-${crypto.randomUUID()}` }, wallet);

    await withConsumer(async (consumer) => {
      await waitFor(drained);
      const metrics = await (await fetch(`${consumer.url}/metrics`)).text();
      expect(metrics).toMatch(
        /wagering_duplicates_detected_total\{source="SQS",type="inbox_duplicate"\} 1/,
      );
      expect(metrics).toMatch(
        /wagering_duplicates_detected_total\{source="SQS",type="idempotent_replay"\} 1/,
      );
    });

    expect(await transactionsOf(wallet)).toHaveLength(1);
    const [row] =
      await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row.balance).toBe('70.00');
  });

  it('rejeição de negócio e wallet inexistente: ack, sem DLQ', async () => {
    await drainDlq(sqs, dlqUrl);
    const wallet = await createWallet(api.url, '10.00');
    await send(envelope(wager(wallet, { money: brl('99.00') })), wallet);
    const ghost = { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() };
    await send(envelope(wager(ghost)), ghost);

    await withConsumer(async () => {
      await waitFor(async () => (await transactionsOf(wallet)).length === 1 && (await drained()));
    });

    const [tx] = await transactionsOf(wallet);
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await drainDlq(sqs, dlqUrl)).toEqual([]);
  });

  it('IT-14 mensagens permanentemente inválidas vão direto para a DLQ', async () => {
    await drainDlq(sqs, dlqUrl);
    const wallet = await createWallet(api.url, '10.00');
    await send('{"isto não é json', wallet);
    await send(envelope(wager(wallet), { type: 'SomethingElse' }), wallet);
    await send(envelope(wager(wallet, { money: brl('25') })), wallet);
    await send(envelope(wager(wallet, { kind: 'OPENING' })), wallet);
    await send(envelope(wager(wallet, { kind: 'REFUND' })), wallet); // sem referência

    await withConsumer(async (consumer) => {
      await waitFor(drained);
      const metrics = await (await fetch(`${consumer.url}/metrics`)).text();
      expect(metrics).toContain('wagering_dlq_messages_total');
    });

    const reasons = (await drainDlq(sqs, dlqUrl)).map((m) => m.reason).sort();
    // valor "25" passa no schema (string) e é recusado pelo Money: VALIDATION_ERROR
    expect(reasons).toEqual([
      'invalid_payload:REFERENCE_REQUIRED',
      'invalid_payload:VALIDATION_ERROR',
      'invalid_schema',
      'malformed_json',
      'unknown_type',
    ]);
    expect(await transactionsOf(wallet)).toHaveLength(0);
  });

  it('D-14 mesmo messageId com payload diferente → DLQ', async () => {
    await drainDlq(sqs, dlqUrl);
    const wallet = await createWallet(api.url, '100.00');
    const message = envelope(wager(wallet, { money: brl('10.00') }));
    await send(message, wallet);
    await send({ ...message, data: { ...message.data, money: brl('11.00') } }, wallet);

    await withConsumer(async () => {
      await waitFor(drained);
    });

    expect((await drainDlq(sqs, dlqUrl)).map((m) => m.reason)).toEqual(['inbox_payload_mismatch']);
    expect(await transactionsOf(wallet)).toHaveLength(1);
  });

  it('IT-13 erro transitório (lock da wallet ocupado): backoff e processamento único depois', async () => {
    const wallet = await createWallet(api.url, '100.00');
    await send(envelope(wager(wallet, { money: brl('5.00') })), wallet);

    // segura o lock da wallet: o consumidor estoura o lock_timeout (transitório)
    let release: () => void = () => {};
    const holder = sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    await withConsumer(
      async (consumer) => {
        await waitFor(async () => {
          const metrics = await (await fetch(`${consumer.url}/metrics`)).text();
          return /wagering_retries_total\{component="consumer"\} [1-9]/.test(metrics);
        });
        release();
        await holder;
        await waitFor(async () => (await transactionsOf(wallet)).length === 1 && (await drained()));
      },
      { DB_LOCK_TIMEOUT_MS: 300 },
    );

    expect(await transactionsOf(wallet)).toHaveLength(1);
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('IT-15 falha persistente: após maxReceiveCount o redrive leva a mensagem à DLQ', async () => {
    await drainDlq(sqs, dlqUrl);
    const wallet = await createWallet(api.url, '100.00');
    await send(envelope(wager(wallet)), wallet);

    await withConsumer(
      async () => {
        await waitFor(drained, 40_000);
      },
      { FAULT_POINTS: 'consumer.before-process' },
    );

    expect(await drainDlq(sqs, dlqUrl)).toHaveLength(1);
    expect(await transactionsOf(wallet)).toHaveLength(0);
  });

  it('CT-05 consumidor morre depois do commit e antes do ack: outra instância não duplica', async () => {
    const wallet = await createWallet(api.url, '100.00');
    await send(envelope(wager(wallet, { money: brl('40.00') })), wallet);

    await withConsumer(
      async () => {
        await waitFor(async () => (await transactionsOf(wallet)).length === 1);
      },
      { FAULT_POINTS: 'consumer.after-commit-before-ack' },
    );
    // a mensagem continua na fila (sem ack); outra instância a recebe após a visibilidade
    expect(await queueDepth(sqs, mainUrl)).toBe(1);

    await withConsumer(async (consumer) => {
      await waitFor(drained);
      const metrics = await (await fetch(`${consumer.url}/metrics`)).text();
      expect(metrics).toMatch(/type="inbox_duplicate"\} 1/);
    });

    expect(await transactionsOf(wallet)).toHaveLength(1);
    const [row] =
      await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row.balance).toBe('60.00');
  });

  it('CT-11 SIGTERM com mensagens em andamento: nada perdido nem duplicado', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(api.url, '50.00')),
    );
    for (const wallet of wallets)
      await send(envelope(wager(wallet, { money: brl('20.00') })), wallet);

    const processed = async () => {
      const [row] = await sql`
        SELECT count(*)::int AS n FROM wager_transactions
         WHERE wallet_id IN ${sql(wallets.map((w) => w.walletId))} AND kind = 'BET'`;
      return row.n as number;
    };

    // encerra o primeiro consumidor assim que ele começa a trabalhar
    await withConsumer(async () => {
      await waitFor(async () => (await processed()) >= 1);
    });
    await withConsumer(async () => {
      await waitFor(async () => (await processed()) === 10 && (await drained()));
    });

    for (const wallet of wallets) {
      const [row] =
        await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
      expect(row.balance).toBe('30.00');
      await assertLedgerConsistency(sql, wallet.walletId);
    }
  });
});
