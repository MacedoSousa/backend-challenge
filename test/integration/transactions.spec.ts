import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { http, type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { brl, createWallet, submit, type TestWallet, wager } from './support/wagering';

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

const newWallet = (initial = '1000.00') => createWallet(running.url, initial);
const post = (body: Parameters<typeof submit>[1], options?: Parameters<typeof submit>[2]) =>
  submit(running.url, body, options);

async function balanceOf(wallet: TestWallet) {
  const [row] = await sql`
    SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.walletId}`;
  return row as { balance: string; version: number };
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await sql`
    SELECT event_type FROM outbox_messages
     WHERE payload->'data'->>'transactionId' = ${transactionId} ORDER BY event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

async function entriesOf(transactionId: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
  return row.n;
}

describe('BET / WIN / LOSS', () => {
  it('BET processada: 201, débito, lançamento, eventos e auditoria', async () => {
    const wallet = await newWallet();
    const res = await post(wager(wallet), { headers: { 'x-correlation-id': 'corr-bet-1' } });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    expect(await balanceOf(wallet)).toEqual({ balance: '975.00', version: 2 });
    expect(await entriesOf(res.body.transactionId)).toBe(1);
    expect(await eventsOf(res.body.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const [audit] = await sql`
      SELECT action, to_status, source, correlation_id, ledger_entry_id IS NOT NULL AS has_entry
        FROM wager_transaction_audit WHERE transaction_id = ${res.body.transactionId}`;
    expect(audit).toEqual({
      action: 'PROCESSED',
      to_status: 'PROCESSED',
      source: 'HTTP',
      correlation_id: 'corr-bet-1',
      has_entry: true,
    });
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('WIN credita; LOSS não move saldo, não gera lançamento nem WalletBalanceChanged', async () => {
    const wallet = await newWallet('100.00');
    const win = await post(wager(wallet, { kind: 'WIN', money: brl('40.00') }));
    expect(win.status).toBe(201);
    expect(win.body.balance).toEqual(brl('140.00'));

    const loss = await post(wager(wallet, { kind: 'LOSS', money: brl('0.00') }));
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({ status: 'PROCESSED', balance: brl('140.00') });
    expect(await entriesOf(loss.body.transactionId)).toBe(0);
    expect(await eventsOf(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect((await balanceOf(wallet)).version).toBe(2); // LOSS não incrementa a versão
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('BET sem saldo → 422 REJECTED persistido e auditável, sem lançamento', async () => {
    const wallet = await newWallet('10.00');
    const res = await post(wager(wallet, { money: brl('10.01') }));
    // Bun 1.4.2: toMatchObject com expect.any() substitui o valor no objeto real — guarde antes
    const transactionId = res.body.transactionId;

    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      status: 422,
      transactionId: expect.any(String),
      transactionStatus: 'REJECTED',
      balance: brl('10.00'),
      idempotentReplay: false,
    });
    expect(await entriesOf(transactionId)).toBe(0);
    expect(await eventsOf(transactionId)).toEqual(['WagerTransactionRejected']);
    expect(await balanceOf(wallet)).toEqual({ balance: '10.00', version: 1 });
  });
});

describe('idempotência', () => {
  it('IT-09 replay devolve o resultado original, com o saldo observado na época', async () => {
    const wallet = await newWallet('100.00');
    const body = wager(wallet, { money: brl('30.00') });
    const first = await post(body);
    await post(wager(wallet, { money: brl('5.00') })); // saldo muda depois

    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('70.00'));
    expect(await entriesOf(first.body.transactionId)).toBe(1);
    expect(await eventsOf(first.body.transactionId)).toHaveLength(2);
  });

  it('IT-10/IT-27 mesma key com payload diferente (1000 e depois 10) → 409, nada muda', async () => {
    const wallet = await newWallet('5000.00');
    const original = wager(wallet, { externalTransactionId: 'bet-1', money: brl('1000.00') });
    expect((await post(original)).status).toBe(201);

    const conflict = await post({ ...original, money: brl('10.00') });
    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(await balanceOf(wallet)).toEqual({ balance: '4000.00', version: 2 });
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('mesmo (provider, id externo) com outra Idempotency-Key → 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    const wallet = await newWallet();
    const body = wager(wallet);
    await post(body);
    const res = await post(body, { key: 'outra-chave' });
    expect(res.status).toBe(409);
    expect(res.body.failureCode).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('IT-11 replay de REJECTED devolve 422 idêntico', async () => {
    const wallet = await newWallet('1.00');
    const body = wager(wallet, { money: brl('2.00') });
    const first = await post(body);
    const replay = await post(body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: true,
    });
  });

  it('Idempotency-Key ausente → 400', async () => {
    const wallet = await newWallet();
    const res = await post(wager(wallet), { key: null });
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('VALIDATION_ERROR');
  });

  it('IT-28 mesmo id externo em provedores diferentes são apostas distintas', async () => {
    const wallet = await newWallet();
    const a = await post(
      wager(wallet, { providerId: 'provider-a', externalTransactionId: 'same' }),
    );
    const b = await post(
      wager(wallet, { providerId: 'provider-b', externalTransactionId: 'same' }),
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.balance).toEqual(brl('950.00'));
  });
});

describe('reversões — fluxo único de REFUND e ROLLBACK', () => {
  it('REFUND credita; ROLLBACK da mesma BET depois → REFERENCE_ALREADY_REVERSED apontando o REFUND', async () => {
    const wallet = await newWallet('100.00');
    const bet = wager(wallet, { externalTransactionId: 'bet-r1', money: brl('40.00') });
    const betRes = await post(bet);

    const refund = await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-r1',
        money: brl('40.00'),
      }),
    );
    expect(refund.status).toBe(201);
    expect(refund.body.balance).toEqual(brl('100.00'));

    const rollback = await post(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'bet-r1',
        money: brl('40.00'),
      }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      relatedTransactionId: refund.body.transactionId,
    });

    const [reversedBy] = await sql`
      SELECT related_transaction_id FROM wager_transaction_audit
       WHERE transaction_id = ${betRes.body.transactionId} AND action = 'REVERSED_BY'`;
    expect(reversedBy.related_transaction_id).toBe(refund.body.transactionId);
    expect((await balanceOf(wallet)).balance).toBe('100.00');
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (código distinto)', async () => {
    const wallet = await newWallet('0.00');
    await post(wager(wallet, { kind: 'WIN', externalTransactionId: 'win-1', money: brl('50.00') }));
    await post(wager(wallet, { money: brl('45.00') }));

    const res = await post(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: 'win-1',
        money: brl('50.00'),
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await balanceOf(wallet)).balance).toBe('5.00');
  });

  it.each([
    ['valor diferente', { money: brl('39.99') }, 'AMOUNT_MISMATCH'],
    ['outra rodada', { roundId: 'round-2' }, 'REFERENCE_MISMATCH'],
  ])('REFUND com %s → %s', async (_case, override, code) => {
    const wallet = await newWallet('100.00');
    const ext = `bet-${crypto.randomUUID()}`;
    await post(wager(wallet, { externalTransactionId: ext, money: brl('40.00') }));
    const res = await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: ext,
        money: brl('40.00'),
        ...override,
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe(code);
  });

  it('REFUND antes da BET → 202 PENDING_REFERENCE + evento; replay → 202', async () => {
    const wallet = await newWallet('100.00');
    const refund = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-ainda-nao-chegou',
      money: brl('10.00'),
    });
    const res = await post(refund);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      balance: null,
      idempotentReplay: false,
    });
    expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionPendingReference']);

    const replay = await post(refund);
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('REFUND sem referência → 400 REFERENCE_REQUIRED', async () => {
    const wallet = await newWallet();
    const res = await post(wager(wallet, { kind: 'REFUND' }));
    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('REFERENCE_REQUIRED');
  });
});

describe('validações de contexto', () => {
  it('IT-29 wallet de outro jogador → 422 WALLET_PLAYER_MISMATCH, saldo intacto', async () => {
    const wallet = await newWallet('100.00');
    const other = await newWallet('100.00');
    const res = await post(wager(wallet, { playerId: other.playerId }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect((await balanceOf(wallet)).balance).toBe('100.00');
  });

  it('moeda diferente da wallet → 422 CURRENCY_MISMATCH', async () => {
    const wallet = await newWallet('100.00');
    const res = await post(wager(wallet, { money: { amount: '1.00', currency: 'USD' } }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  it('wallet inexistente → 404 WALLET_NOT_FOUND (não persiste)', async () => {
    const wallet = { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const res = await post(wager(wallet));
    expect(res.status).toBe(404);
    expect(res.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  it.each([
    ['kind OPENING', { kind: 'OPENING' }],
    ['valor sem 2 casas', { money: brl('25') }],
    ['playerId inválido (IT-30)', { playerId: 'jogador@email.com' }],
    ['campo extra', { balance: '1.00' }],
  ])('%s → 400', async (_case, override) => {
    const wallet = await newWallet();
    const res = await post({ ...wager(wallet), ...override });
    expect(res.status).toBe(400);
  });
});

describe('consultas e auditoria', () => {
  it('GET por id interno e por (provider, id externo)', async () => {
    const wallet = await newWallet();
    const body = wager(wallet);
    const res = await post(body);

    const byId = await http(`${running.url}/wagering/transactions/${res.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: res.body.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: brl('25.00'),
      balanceAfter: brl('975.00'),
    });
    const byExternal = await http(
      `${running.url}/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byExternal.body).toEqual(byId.body);

    expect((await http(`${running.url}/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
  });

  it('IT-23 linha do tempo: PROCESSED → REPLAY → CONFLITO → REVERSED_BY', async () => {
    const wallet = await newWallet();
    const bet = wager(wallet, { externalTransactionId: 'bet-audit', money: brl('20.00') });
    const res = await post(bet);
    await post(bet);
    await post({ ...bet, money: brl('21.00') });
    await post(
      wager(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-audit',
        money: brl('20.00'),
      }),
    );

    const timeline = await http<{ items: { action: string; source: string }[] }>(
      `${running.url}/wagering/transactions/${res.body.transactionId}/audit`,
    );
    expect(timeline.status).toBe(200);
    expect(timeline.body.items.map((item) => item.action)).toEqual([
      'PROCESSED',
      'IDEMPOTENT_REPLAY',
      'IDEMPOTENCY_CONFLICT',
      'REVERSED_BY',
    ]);
    expect(timeline.body.items.every((item) => item.source === 'HTTP')).toBe(true);
  });

  it('IT-22 auditoria é append-only', async () => {
    const message = await sql`UPDATE wager_transaction_audit SET action = 'FAILED'`.then(
      () => 'sem erro',
      (error: Error) => error.message,
    );
    expect(message).toContain('append-only');
  });

  it('IT-25 todo lançamento do ledger tem exatamente uma auditoria PROCESSED', async () => {
    const [row] = await sql`
      SELECT count(*)::int AS orphans FROM wallet_ledger_entries e
       WHERE (SELECT count(*) FROM wager_transaction_audit a
               WHERE a.ledger_entry_id = e.id AND a.action = 'PROCESSED') <> 1`;
    expect(row.orphans).toBe(0);
  });
});

describe('métricas (§12)', () => {
  it('expõe transações por status, duplicatas e espera de lock', async () => {
    const text = await (await fetch(`${running.url}/metrics`)).text();
    expect(text).toMatch(
      /wagering_transactions_total\{kind="BET",status="PROCESSED",source="HTTP"\} \d+/,
    );
    expect(text).toMatch(
      /wagering_transactions_total\{kind="BET",status="REJECTED",source="HTTP"\} \d+/,
    );
    expect(text).toMatch(
      /wagering_duplicates_detected_total\{source="HTTP",type="idempotent_replay"\} \d+/,
    );
    expect(text).toMatch(
      /wagering_duplicates_detected_total\{source="HTTP",type="payload_conflict"\} \d+/,
    );
    expect(text).toContain('wagering_lock_wait_seconds_bucket');
    expect(text).toContain('wagering_processing_duration_seconds_bucket');
  });
});
