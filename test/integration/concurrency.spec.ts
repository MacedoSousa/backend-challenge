import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { type RunningApp, startApp } from './support/app';
import { assertLedgerConsistency, connect } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { brl, createWallet, submit, wager } from './support/wagering';

let infra: TestEnvironment;
let running: RunningApp;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment({ DB_POOL_MAX: '20' });
  running = await startApp(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await running?.close();
  await infra?.stop();
});

/** Dispara todas as requisições juntas (barreira de largada) e espera todas. */
function burst<T>(count: number, request: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => request(index)));
}

async function debitsOf(walletId: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM wallet_ledger_entries
     WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return row.n;
}

describe('concorrência real (§13)', () => {
  it('CT-01 a mesma aposta 50× em paralelo → um único débito', async () => {
    const wallet = await createWallet(running.url, '1000.00');
    const body = wager(wallet, { money: brl('100.00') });

    const results = await burst(50, () => submit(running.url, body));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance?.amount === '900.00')).toBe(true);

    expect(await debitsOf(wallet.walletId)).toBe(1);
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('CT-02 cenário obrigatório: 100.00 e duas BET de 80.00 simultâneas', async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await createWallet(running.url, '100.00');
      const results = await burst(2, () =>
        submit(running.url, wager(wallet, { money: brl('80.00') })),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const rejected = results.find((r) => r.status === 422);
      expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');

      const [row] =
        await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
      expect(row.balance).toBe('20.00');
      expect(await debitsOf(wallet.walletId)).toBe(1);
      await assertLedgerConsistency(sql, wallet.walletId);
    }
  });

  it('CT-03 wallets distintas processadas em paralelo, todas consistentes', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => createWallet(running.url, '50.00')),
    );
    const results = await burst(100, (i) => {
      const wallet = wallets[i % wallets.length];
      if (!wallet) throw new Error('wallet ausente');
      return submit(running.url, wager(wallet, { money: brl('5.00') }));
    });
    expect(results.every((r) => r.status === 201)).toBe(true);

    for (const wallet of wallets) {
      const [row] =
        await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
      expect(row.balance).toBe('0.00');
      await assertLedgerConsistency(sql, wallet.walletId);
    }
  });

  it('CT-10 REFUND e ROLLBACK simultâneos da mesma BET → exatamente uma reversão', async () => {
    for (let round = 0; round < 10; round += 1) {
      const wallet = await createWallet(running.url, '100.00');
      const betId = `bet-${crypto.randomUUID()}`;
      await submit(
        running.url,
        wager(wallet, { externalTransactionId: betId, money: brl('30.00') }),
      );

      const results = await burst(2, (i) =>
        submit(
          running.url,
          wager(wallet, {
            kind: i === 0 ? 'REFUND' : 'ROLLBACK',
            referenceExternalTransactionId: betId,
            money: brl('30.00'),
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const winner = results.find((r) => r.status === 201);
      const loser = results.find((r) => r.status === 422);
      expect(loser?.body).toMatchObject({
        failureCode: 'REFERENCE_ALREADY_REVERSED',
        relatedTransactionId: winner?.body.transactionId,
      });

      const [row] =
        await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
      expect(row.balance).toBe('100.00');
      await assertLedgerConsistency(sql, wallet.walletId);
    }
  });

  it('CT-12 (1 instância) apostas simultâneas de jogos diferentes nunca gastam o saldo duas vezes', async () => {
    const amounts = [
      '7.00',
      '13.00',
      '25.00',
      '40.00',
      '9.00',
      '31.00',
      '18.00',
      '22.00',
      '5.00',
      '50.00',
    ];
    for (let round = 0; round < 5; round += 1) {
      const wallet = await createWallet(running.url, '100.00');
      const results = await burst(amounts.length * 2, (i) =>
        submit(
          running.url,
          wager(wallet, {
            gameId: `game-${i % 5}`,
            money: brl(amounts[i % amounts.length] ?? '1.00'),
          }),
        ),
      );
      expect(results.every((r) => r.status === 201 || r.status === 422)).toBe(true);
      expect(
        results
          .filter((r) => r.status === 422)
          .every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS'),
      ).toBe(true);

      const [row] = await sql`
        SELECT balance::text AS balance,
               (SELECT COALESCE(SUM(amount), 0)::numeric(20,2)::text FROM wallet_ledger_entries
                 WHERE wallet_id = ${wallet.walletId} AND direction = 'DEBIT') AS debited
          FROM wallets WHERE id = ${wallet.walletId}`;
      const [check] = await sql`SELECT (${row.debited}::numeric <= 100.00) AS within_balance`;
      expect(check.within_balance).toBe(true);
      await assertLedgerConsistency(sql, wallet.walletId);
    }
  });
});
