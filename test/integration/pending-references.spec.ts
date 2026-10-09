import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import type { Env } from '../../src/config/env';
import { http, type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { waitFor } from './support/queues';
import { brl, createWallet, submit, type TestWallet, wager } from './support/wagering';

let infra: TestEnvironment;
let api: RunningApp;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment();
  api = await startApp(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await api?.close();
  await infra?.stop();
});

/** Worker (APP_ROLE=scheduler) com varredura e backoff curtos para os testes. */
async function withScheduler<T>(fn: () => Promise<T>, overrides: Partial<Env> = {}, count = 1) {
  const schedulers = await Promise.all(
    Array.from({ length: count }, () =>
      startApp(
        {
          ...infra.env,
          APP_ROLE: ['scheduler'],
          PENDING_WORKER_INTERVAL_MS: 50,
          PENDING_WORKER_BATCH_SIZE: 3,
          REFERENCE_RETRY_BASE_MS: 100,
          REFERENCE_RETRY_MAX_DELAY_MS: 200,
          ...overrides,
        } as Env,
        { skipSetup: true },
      ),
    ),
  );
  try {
    return await fn();
  } finally {
    await Promise.all(schedulers.map((s) => s.close()));
  }
}

const post = (body: Parameters<typeof submit>[1]) => submit(api.url, body);

async function statusOf(transactionId: string) {
  const [row] = await sql`
    SELECT status, failure_code, attempts FROM wager_transactions WHERE id = ${transactionId}`;
  return row as { status: string; failure_code: string | null; attempts: number };
}

async function balanceOf(wallet: TestWallet) {
  const [row] =
    await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
  return row.balance as string;
}

describe('worker de referências pendentes (§7.1)', () => {
  it('CT-07 REFUND antes da BET: o worker resolve quando a BET chega', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const refund = await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-ct07',
        money: brl('25.00'),
      }),
    );
    expect(refund.status).toBe(202);
    const bet = await post(
      wager(wallet, { externalTransactionId: 'bet-ct07', money: brl('25.00') }),
    );
    expect(bet.body.balance).toEqual(brl('75.00'));

    await withScheduler(async () => {
      await waitFor(async () => (await statusOf(refund.body.transactionId)).status === 'PROCESSED');
    });

    expect(await balanceOf(wallet)).toBe('100.00');
    const timeline = await http<{ items: { action: string; source: string }[] }>(
      `${api.url}/wagering/transactions/${refund.body.transactionId}/audit`,
    );
    expect(timeline.body.items.map((i) => `${i.action}:${i.source}`)).toEqual([
      'PENDING_REFERENCE:HTTP',
      'PROCESSED:WORKER',
    ]);
    const events = await sql`
      SELECT event_type FROM outbox_messages
       WHERE payload->'data'->>'transactionId' = ${refund.body.transactionId} ORDER BY occurred_at, event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('D-15 cadeia fora de ordem: ROLLBACK do REFUND → REFUND da BET → BET', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const rollback = await post(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'refund-x',
        money: brl('40.00'),
      }),
    );
    const refund = await post(
      wager(wallet, {
        kind: 'REFUND',
        externalTransactionId: 'refund-x',
        referenceExternalTransactionId: 'bet-x',
        money: brl('40.00'),
      }),
    );
    expect([rollback.status, refund.status]).toEqual([202, 202]);
    await post(wager(wallet, { externalTransactionId: 'bet-x', money: brl('40.00') }));

    await withScheduler(async () => {
      await waitFor(
        async () => (await statusOf(rollback.body.transactionId)).status === 'PROCESSED',
      );
    });

    expect((await statusOf(refund.body.transactionId)).status).toBe('PROCESSED');
    // BET debita 40, REFUND devolve 40, ROLLBACK do REFUND debita 40 de novo
    expect(await balanceOf(wallet)).toBe('60.00');
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('referência nunca chega: retries com backoff e REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const wallet = await createWallet(api.url, '100.00');
    const refund = await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'nunca-chega',
        money: brl('10.00'),
      }),
    );

    await withScheduler(
      async () => {
        await waitFor(
          async () => (await statusOf(refund.body.transactionId)).status === 'REJECTED',
        );
      },
      { REFERENCE_RETRY_MAX_ATTEMPTS: 3 },
    );

    expect(await statusOf(refund.body.transactionId)).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      attempts: 2,
    });
    const actions = await sql`
      SELECT action FROM wager_transaction_audit
       WHERE transaction_id = ${refund.body.transactionId} ORDER BY occurred_at, id`;
    expect(actions.map((a: { action: string }) => a.action)).toEqual([
      'PENDING_REFERENCE',
      'RETRY_SCHEDULED',
      'RETRY_SCHEDULED',
      'REJECTED',
    ]);
    const [event] = await sql`
      SELECT payload->'data'->>'failureCode' AS code FROM outbox_messages
       WHERE event_type = 'WagerTransactionRejected'
         AND payload->'data'->>'transactionId' = ${refund.body.transactionId}`;
    expect(event.code).toBe('REFERENCE_NOT_FOUND');
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  it('referência chega REJEITADA: a pendente vira REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await createWallet(api.url, '10.00');
    const refund = await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-sem-saldo',
        money: brl('50.00'),
      }),
    );
    const bet = await post(
      wager(wallet, { externalTransactionId: 'bet-sem-saldo', money: brl('50.00') }),
    );
    expect(bet.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    await withScheduler(async () => {
      await waitFor(async () => (await statusOf(refund.body.transactionId)).status === 'REJECTED');
    });
    expect((await statusOf(refund.body.transactionId)).failure_code).toBe(
      'REFERENCE_NOT_PROCESSED',
    );
    expect(await balanceOf(wallet)).toBe('10.00');
  });

  it('dois workers concorrentes: cada pendência resolvida uma única vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(api.url, '100.00')),
    );
    const refunds: string[] = [];
    for (const [i, wallet] of wallets.entries()) {
      const refund = await post(
        wager(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: `bet-c${i}`,
          money: brl('15.00'),
        }),
      );
      refunds.push(refund.body.transactionId);
      await post(wager(wallet, { externalTransactionId: `bet-c${i}`, money: brl('15.00') }));
    }

    await withScheduler(
      async () => {
        await waitFor(async () => {
          const [row] = await sql`
            SELECT count(*)::int AS n FROM wager_transactions
             WHERE id IN ${sql(refunds)} AND status = 'PROCESSED'`;
          return row.n === 10;
        });
      },
      {},
      2,
    );

    for (const wallet of wallets) {
      expect(await balanceOf(wallet)).toBe('100.00');
      await assertLedgerConsistency(sql, wallet.walletId);
    }
    const [credits] = await sql`
      SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id IN ${sql(refunds)}`;
    expect(credits.n).toBe(10);
  });
});
