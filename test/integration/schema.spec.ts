import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import {
  assertLedgerConsistency,
  connect,
  insertTransaction,
  migrate,
  seedMovements,
  seedWallet,
  uuid,
} from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';

let infra: TestEnvironment;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment();
  await migrate(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await infra?.stop();
});

/** Executa e devolve a mensagem de erro do Postgres (ou falha se não houver erro). */
async function rejects(statement: () => Promise<unknown>): Promise<string> {
  try {
    await statement();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('o banco deveria ter recusado a operação');
}

describe('schema — garantias no banco (restrição 9)', () => {
  it('IT-02 saldo negativo é recusado por CHECK', async () => {
    const message = await rejects(
      () => sql`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${uuid()}, ${uuid()}, 'BRL', -0.01, 1, now(), now())`,
    );
    expect(message).toContain('wallets_balance_check');
  });

  it('IT-03 ledger é append-only: UPDATE, DELETE e TRUNCATE são recusados', async () => {
    const wallet = await seedWallet(sql, '100.00');
    expect(
      await rejects(
        () => sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${wallet.walletId}`,
      ),
    ).toContain('append-only');
    expect(
      await rejects(
        () => sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}`,
      ),
    ).toContain('append-only');
    expect(await rejects(() => sql`TRUNCATE wallet_ledger_entries CASCADE`)).toContain(
      'append-only',
    );
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('IT-04 uma wallet por jogador e moeda', async () => {
    const playerId = uuid();
    const insert = (currency: string) => sql`
      INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${uuid()}, ${playerId}, ${currency}, 0, 1, now(), now())`;
    await insert('BRL');
    await insert('USD');
    expect(await rejects(() => insert('BRL'))).toContain('uq_wallet_player_currency');
  });

  it('IT-05 lançamento com aritmética errada é recusado', async () => {
    const wallet = await seedWallet(sql, '100.00');
    const message = await rejects(() =>
      sql.begin(async (tx) => {
        const txId = uuid();
        await insertTransaction(tx, {
          id: txId,
          walletId: wallet.walletId,
          playerId: wallet.playerId,
          kind: 'BET',
          providerId: 'p',
          externalId: txId,
          amount: '10.00',
          balanceAfter: '80.00',
        });
        await tx`
          INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction,
            amount, currency, balance_before, balance_after, created_at)
          VALUES (${uuid()}, ${wallet.walletId}, 2, ${txId}, 'DEBIT', 10, 'BRL', 100, 80, now())`;
      }),
    );
    expect(message).toContain('ck_ledger_arithmetic');
  });

  it('IT-06 segunda reversão PROCESSED da mesma referência é recusada (D-01)', async () => {
    const wallet = await seedWallet(sql, '100.00');
    const betId = uuid();
    await insertTransaction(sql, {
      id: betId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: 'BET',
      providerId: 'p',
      externalId: betId,
      amount: '10.00',
      balanceAfter: '90.00',
    });
    const reversal = (kind: string) => {
      const id = uuid();
      return insertTransaction(sql, {
        id,
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind,
        providerId: 'p',
        externalId: id,
        amount: '10.00',
        balanceAfter: '100.00',
        referenceTransactionId: betId,
      });
    };
    await reversal('REFUND');
    expect(await rejects(() => reversal('ROLLBACK'))).toContain('uq_tx_single_reversal');
  });

  it('no máximo um lançamento por transação e wallet (§6.4)', async () => {
    const wallet = await seedWallet(sql, '100.00');
    const [opening] = await sql`
      SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}`;
    const message = await rejects(
      () => sql`
        INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction,
          amount, currency, balance_before, balance_after, created_at)
        VALUES (${uuid()}, ${wallet.walletId}, 2, ${opening.transaction_id}, 'CREDIT', 1, 'BRL',
          100, 101, now())`,
    );
    expect(message).toContain('uq_ledger_tx_wallet');
  });

  it('cadeia do ledger: balance_before precisa ser o balance_after anterior', async () => {
    const wallet = await seedWallet(sql, '100.00');
    const message = await rejects(() =>
      sql.begin(async (tx) => {
        const txId = uuid();
        await insertTransaction(tx, {
          id: txId,
          walletId: wallet.walletId,
          playerId: wallet.playerId,
          kind: 'BET',
          providerId: 'p',
          externalId: txId,
          amount: '10.00',
          balanceAfter: '40.00',
        });
        await tx`
          INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction,
            amount, currency, balance_before, balance_after, created_at)
          VALUES (${uuid()}, ${wallet.walletId}, 2, ${txId}, 'DEBIT', 10, 'BRL', 50, 40, now())`;
      }),
    );
    expect(message).toContain('ledger chain broken');
  });

  it('consistência no commit: saldo alterado sem lançamento é recusado', async () => {
    const wallet = await seedWallet(sql, '100.00');
    const message = await rejects(
      () => sql`UPDATE wallets SET balance = 1000, version = 2 WHERE id = ${wallet.walletId}`,
    );
    expect(message).toContain('does not match ledger');
    await assertLedgerConsistency(sql, wallet.walletId);
  });

  it('consistência no commit: wallet com saldo inicial sem lançamento é recusada', async () => {
    const message = await rejects(
      () => sql`
        INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${uuid()}, ${uuid()}, 'BRL', 50, 1, now(), now())`,
    );
    expect(message).toContain('without ledger entries');
  });

  it.each([
    ['REFUND sem referência', 'ck_tx_reference_required', { kind: 'REFUND', ref: null }],
    ['OPENING de provedor externo', 'ck_tx_opening_internal', { kind: 'OPENING', provider: 'p' }],
    ['REJECTED sem failure_code', 'ck_tx_failure_code', { status: 'REJECTED' }],
    ['BET de valor zero', 'ck_tx_amount_positive', { amount: '0.00' }],
  ])('%s é recusado', async (_case, constraint, override) => {
    const wallet = await seedWallet(sql, '100.00');
    const o = override as { kind?: string; provider?: string; status?: string; amount?: string };
    const message = await rejects(
      () => sql`
        INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
          payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
          balance_after, created_at, processed_at)
        VALUES (${uuid()}, ${o.provider ?? 'p'}, ${uuid()}, ${uuid()}, ${'a'.repeat(64)},
          ${wallet.walletId}, ${wallet.playerId}, 'r', 'g', ${o.kind ?? 'BET'},
          ${o.amount ?? '10.00'}::numeric, 'BRL', ${o.status ?? 'PROCESSED'}, 90, now(), now())`,
    );
    expect(message).toContain(constraint);
  });

  it('movimentos coerentes passam por todas as barreiras', async () => {
    const wallet = await seedWallet(sql, '100.00');
    await seedMovements(sql, wallet, [
      { direction: 'DEBIT', amount: '30.00' },
      { direction: 'CREDIT', amount: '12.50' },
      { direction: 'DEBIT', amount: '82.50' },
    ]);
    const [row] =
      await sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row.balance).toBe('0.00');
    await assertLedgerConsistency(sql, wallet.walletId);
  });
});
