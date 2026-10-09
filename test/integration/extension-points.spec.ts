import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { PLAYER_SESSION_POLICY } from '../../src/shared/application/ports';
import { type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { brl, createWallet, submit, wager } from './support/wagering';

let infra: TestEnvironment;
let normal: RunningApp;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment();
  normal = await startApp(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await normal?.close();
  await infra?.stop();
});

describe('IT-07 atomicidade: falha antes do COMMIT não deixa rastro', () => {
  it('nenhuma transação, lançamento, saldo, evento ou auditoria é gravado; o reenvio aplica uma vez', async () => {
    const faulty = await startApp(
      { ...infra.env, FAULT_POINTS: 'wager.before-commit' },
      { skipSetup: true },
    );
    try {
      const wallet = await createWallet(normal.url, '100.00');
      const body = wager(wallet, { externalTransactionId: 'bet-atomic', money: brl('40.00') });

      const failed = await submit(faulty.url, body);
      expect(failed.status).toBe(500);

      const [counts] = await sql`
        SELECT
          (SELECT count(*)::int FROM wager_transactions WHERE external_transaction_id = 'bet-atomic') AS txs,
          (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}) AS entries,
          (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ${wallet.walletId}) AS events,
          (SELECT count(*)::int FROM wager_transaction_audit WHERE wallet_id = ${wallet.walletId}) AS audits,
          (SELECT balance::text FROM wallets WHERE id = ${wallet.walletId}) AS balance`;
      // só o que a criação da wallet gravou: OPENING (1 lançamento, 2 eventos, 1 auditoria)
      expect(counts).toEqual({ txs: 0, entries: 1, events: 2, audits: 1, balance: '100.00' });

      const retried = await submit(normal.url, body);
      expect(retried.status).toBe(201);
      expect(retried.body.balance).toEqual(brl('60.00'));
      await assertLedgerConsistency(sql, wallet.walletId);
    } finally {
      await faulty.close();
    }
  });
});

describe('IT-31 PlayerSessionPolicy é um ponto de extensão real (D-19)', () => {
  it('uma política que nega rejeita a BET com CONCURRENT_GAME_NOT_ALLOWED, sem débito', async () => {
    const restricted = await startApp(infra.env, {
      skipSetup: true,
      overrides: [{ provide: PLAYER_SESSION_POLICY, useValue: { canBet: async () => false } }],
    });
    try {
      const wallet = await createWallet(restricted.url, '100.00');
      const res = await submit(restricted.url, wager(wallet));
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('CONCURRENT_GAME_NOT_ALLOWED');

      // a política só vale para BET: WIN continua permitido
      const win = await submit(restricted.url, wager(wallet, { kind: 'WIN' }));
      expect(win.status).toBe(201);
      await assertLedgerConsistency(sql, wallet.walletId);
    } finally {
      await restricted.close();
    }
  });
});
