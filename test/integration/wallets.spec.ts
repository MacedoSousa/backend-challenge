import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { http, type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect, seedMovements, uuid } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';

let infra: TestEnvironment;
let running: RunningApp;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment();
  running = await startApp(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await running?.close();
  await infra?.stop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
const createWallet = (body: unknown, headers: Record<string, string> = {}) =>
  http(`${running.url}/wallets`, { method: 'POST', body, headers });

describe('POST /wallets (IT-08)', () => {
  it('cria a wallet com OPENING, CREDIT e eventos na outbox, tudo na mesma transação', async () => {
    const playerId = uuid();
    const res = await createWallet(
      { playerId, initialBalance: brl('1000.00') },
      { 'x-correlation-id': 'corr-open-1' },
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId, balance: brl('1000.00'), version: 1 });
    const walletId = res.body.id as string;

    const [opening] = await sql`
      SELECT kind, status, provider_id, idempotency_key, amount::text AS amount,
             balance_after::text AS balance_after
        FROM wager_transactions WHERE wallet_id = ${walletId}`;
    expect(opening).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      provider_id: 'internal',
      idempotency_key: `internal:opening:${walletId}`,
      amount: '1000.00',
      balance_after: '1000.00',
    });

    const entries = await sql`
      SELECT direction, wallet_version, balance_before::text AS before, balance_after::text AS after
        FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
    expect(entries).toEqual([
      { direction: 'CREDIT', wallet_version: 1, before: '0.00', after: '1000.00' },
    ]);

    const events = await sql`
      SELECT event_type, aggregate_id, payload->>'correlationId' AS correlation_id,
             payload->'data'->'balanceAfter'->>'amount' AS balance_after, published_at
        FROM outbox_messages WHERE aggregate_id = ${walletId} ORDER BY event_type`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.correlation_id).toBe('corr-open-1');
      expect(event.balance_after).toBe('1000.00');
      expect(event.published_at).toBeNull();
    }
    await assertLedgerConsistency(sql, walletId);
  });

  it('saldo inicial zero: nenhuma transação, lançamento ou evento de saldo', async () => {
    const res = await createWallet({ playerId: uuid(), initialBalance: brl('0.00') });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ balance: brl('0.00'), version: 1 });
    const walletId = res.body.id as string;

    const [counts] = await sql`
      SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${walletId}) AS txs,
             (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${walletId}) AS entries,
             (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${walletId}) AS events`;
    expect(counts).toEqual({ txs: 0, entries: 0, events: 0 });
  });

  it('wallet duplicada para o mesmo jogador e moeda → 409; outra moeda é permitida', async () => {
    const playerId = uuid();
    expect((await createWallet({ playerId, initialBalance: brl('10.00') })).status).toBe(201);

    const duplicate = await createWallet({ playerId, initialBalance: brl('99.00') });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ failureCode: 'WALLET_ALREADY_EXISTS', status: 409 });
    expect(duplicate.headers.get('content-type')).toContain('application/problem+json');

    const usd = await createWallet({
      playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
  });

  it('10 criações simultâneas para o mesmo jogador: exatamente uma vence', async () => {
    const playerId = uuid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createWallet({ playerId, initialBalance: brl('50.00') })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);

    const [row] = await sql`
      SELECT count(*)::int AS wallets FROM wallets WHERE player_id = ${playerId}`;
    expect(row.wallets).toBe(1);
  });

  it.each([
    [
      'playerId fora do formato UUID (IT-30)',
      { playerId: 'player@email.com', initialBalance: brl('1.00') },
    ],
    ['valor sem 2 casas', { playerId: uuid(), initialBalance: brl('1000') }],
    ['valor negativo', { playerId: uuid(), initialBalance: brl('-1.00') }],
    ['notação científica', { playerId: uuid(), initialBalance: brl('1e3') }],
    ['valor como number', { playerId: uuid(), initialBalance: { amount: 10, currency: 'BRL' } }],
    ['moeda inválida', { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'real' } }],
    ['campo extra', { playerId: uuid(), initialBalance: brl('1.00'), balance: '9.00' }],
  ])('%s → 400 VALIDATION_ERROR', async (_case, body) => {
    const res = await createWallet(body, { 'x-correlation-id': 'corr-invalid' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      failureCode: 'VALIDATION_ERROR',
      status: 400,
      correlationId: 'corr-invalid',
    });
  });

  it('JSON malformado → 400 VALIDATION_ERROR', async () => {
    const res = await createWallet('{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:id', () => {
  it('devolve a wallet', async () => {
    const created = await createWallet({ playerId: uuid(), initialBalance: brl('42.00') });
    const res = await http(`${running.url}/wallets/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.body.id, balance: brl('42.00'), version: 1 });
  });

  it('wallet inexistente → 404 WALLET_NOT_FOUND; id malformado → 400', async () => {
    const missing = await http(`${running.url}/wallets/${uuid()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.failureCode).toBe('WALLET_NOT_FOUND');

    expect((await http(`${running.url}/wallets/not-a-uuid`)).status).toBe(400);
  });
});

describe('GET /wallets/:id/ledger (IT-19)', () => {
  type Page = { items: { walletVersion: number }[]; nextCursor: string | null };

  it('pagina com cursor opaco e estável, mesmo com inserções entre as páginas', async () => {
    const created = await createWallet({ playerId: uuid(), initialBalance: brl('100.00') });
    const wallet = {
      walletId: created.body.id as string,
      playerId: created.body.playerId as string,
    };
    await seedMovements(sql, wallet, [
      { direction: 'DEBIT', amount: '10.00' },
      { direction: 'DEBIT', amount: '20.00' },
      { direction: 'CREDIT', amount: '5.00' },
      { direction: 'DEBIT', amount: '1.00' },
    ]);
    const ledgerUrl = `${running.url}/wallets/${wallet.walletId}/ledger`;

    const first = await http<Page>(`${ledgerUrl}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i) => i.walletVersion)).toEqual([1, 2]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.nextCursor).not.toContain('2'); // opaco: não expõe a versão em claro

    // nova movimentação entre as páginas não desloca o que já foi lido
    await seedMovements(sql, wallet, [{ direction: 'CREDIT', amount: '7.00' }]);

    const second = await http<Page>(`${ledgerUrl}?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i) => i.walletVersion)).toEqual([3, 4]);
    const third = await http<Page>(`${ledgerUrl}?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((i) => i.walletVersion)).toEqual([5, 6]);
    expect(third.body.nextCursor).toBeNull();

    expect(first.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: brl('100.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('100.00'),
    });
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it.each([
    ['cursor inválido', '?cursor=bad'],
    ['limit acima de 200', '?limit=201'],
    ['limit zero', '?limit=0'],
  ])('%s → 400', async (_case, query) => {
    const created = await createWallet({ playerId: uuid(), initialBalance: brl('1.00') });
    const res = await http(`${running.url}/wallets/${created.body.id}/ledger${query}`);
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('VALIDATION_ERROR');
  });
});

describe('POST /wallets/:id/reconciliation (IT-20)', () => {
  const reconcile = (walletId: string) =>
    http(`${running.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });

  it('wallet consistente', async () => {
    const created = await createWallet({ playerId: uuid(), initialBalance: brl('975.00') });
    const res = await reconcile(created.body.id as string);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: created.body.id,
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 1,
    });
  });

  it('divergência é sinalizada, contada em métrica e NÃO corrigida', async () => {
    const created = await createWallet({ playerId: uuid(), initialBalance: brl('100.00') });
    const walletId = created.body.id as string;
    const metricsBefore = await divergenceCount();

    // corrupção proposital: só um superusuário desligando triggers consegue isso
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE wallets SET balance = 130.00 WHERE id = ${walletId}`;
    });

    const res = await reconcile(walletId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: brl('130.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('30.00'),
      consistent: false,
      checkedEntries: 1,
    });
    expect(await divergenceCount()).toBe(metricsBefore + 1);

    const [row] = await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
    expect(row.balance).toBe('130.00');
  });

  it('wallet inexistente → 404', async () => {
    expect((await reconcile(uuid())).status).toBe(404);
  });

  async function divergenceCount(): Promise<number> {
    const text = await (await fetch(`${running.url}/metrics`)).text();
    const match = /^wagering_reconciliation_divergence_total (\d+)/m.exec(text);
    return match?.[1] ? Number.parseInt(match[1], 10) : 0;
  }
});

describe('GET /metrics', () => {
  it('expõe métricas Prometheus sem autenticação', async () => {
    const res = await fetch(`${running.url}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('wagering_reconciliations_total');
  });
});
