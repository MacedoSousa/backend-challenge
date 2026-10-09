import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import type { Env } from '../../../src/config/env';
import { createOrmConfig } from '../../../src/database/mikro-orm.config';
import { Money } from '../../../src/shared/domain/money';

/** Aplica as migrations no banco do container. */
export async function migrate(env: Env): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig(env));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

/** Cliente SQL independente da aplicação, para preparar e verificar o banco nos testes. */
export function connect(env: Env): SQL {
  return new SQL(env.DATABASE_URL);
}

export const uuid = () => Bun.randomUUIDv7();

export interface SeedWallet {
  walletId: string;
  playerId: string;
}

/** Wallet BRL com saldo inicial coerente com o ledger (OPENING + CREDIT na mesma transação). */
export async function seedWallet(sql: SQL, initial = '100.00'): Promise<SeedWallet> {
  const walletId = uuid();
  const playerId = uuid();
  const positive = initial !== '0.00';
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${walletId}, ${playerId}, 'BRL', ${initial}::numeric, 1, now(), now())`;
    if (positive) {
      const txId = uuid();
      await insertTransaction(tx, {
        id: txId,
        walletId,
        playerId,
        kind: 'OPENING',
        providerId: 'internal',
        externalId: walletId,
        amount: initial,
        balanceAfter: initial,
      });
      await tx`
        INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction,
          amount, currency, balance_before, balance_after, created_at)
        VALUES (${uuid()}, ${walletId}, 1, ${txId}, 'CREDIT', ${initial}::numeric, 'BRL', 0,
          ${initial}::numeric, now())`;
    }
  });
  return { walletId, playerId };
}

export interface Movement {
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
}

/**
 * Registra movimentos coerentes (transação PROCESSED + lançamento + saldo) como a
 * aplicação fará a partir da I3. Usado para montar cenários de ledger/reconciliação.
 */
export async function seedMovements(sql: SQL, wallet: SeedWallet, movements: Movement[]) {
  for (const movement of movements) {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.walletId} FOR UPDATE`;
      const before = Money.from({ amount: row.balance, currency: 'BRL' });
      const amount = Money.from({ amount: movement.amount, currency: 'BRL' });
      const after = (
        movement.direction === 'CREDIT' ? before.add(amount) : before.subtract(amount)
      ).toJSON().amount;
      const version = row.version + 1;
      const txId = uuid();
      await insertTransaction(tx, {
        id: txId,
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: movement.direction === 'CREDIT' ? 'WIN' : 'BET',
        providerId: 'seed',
        externalId: txId,
        amount: movement.amount,
        balanceAfter: after,
      });
      await tx`
        INSERT INTO wallet_ledger_entries (id, wallet_id, wallet_version, transaction_id, direction,
          amount, currency, balance_before, balance_after, created_at)
        VALUES (${uuid()}, ${wallet.walletId}, ${version}, ${txId}, ${movement.direction},
          ${movement.amount}::numeric, 'BRL', ${row.balance}::numeric, ${after}::numeric, now())`;
      await tx`
        UPDATE wallets SET balance = ${after}::numeric, version = ${version}, updated_at = now()
         WHERE id = ${wallet.walletId}`;
    });
  }
}

interface TransactionRow {
  id: string;
  walletId: string;
  playerId: string;
  kind: string;
  providerId: string;
  externalId: string;
  amount: string;
  balanceAfter: string;
  status?: string;
  referenceTransactionId?: string;
}

export async function insertTransaction(sql: SQL, row: TransactionRow): Promise<void> {
  const isOpening = row.kind === 'OPENING';
  const isReversal = row.kind === 'REFUND' || row.kind === 'ROLLBACK';
  await sql`
    INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
      payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, reference_transaction_id, status, balance_after,
      created_at, processed_at)
    VALUES (${row.id}, ${row.providerId}, ${row.externalId}, ${`${row.providerId}:${row.externalId}`},
      ${'a'.repeat(64)}, ${row.walletId}, ${row.playerId},
      ${isOpening ? null : 'round-1'}, ${isOpening ? null : 'game-1'}, ${row.kind},
      ${row.amount}::numeric, 'BRL', ${isReversal ? 'ref' : null}, ${row.referenceTransactionId ?? null},
      ${row.status ?? 'PROCESSED'}, ${row.balanceAfter}::numeric, now(), now())`;
}

/**
 * Invariante final do §13: saldo materializado == saldo reconstruído pelo ledger, a cadeia
 * before/after é contínua e as versões não têm buracos.
 */
export async function assertLedgerConsistency(sql: SQL, walletId: string): Promise<void> {
  const [wallet] = await sql`
    SELECT balance::text AS balance, version FROM wallets WHERE id = ${walletId}`;
  const entries = await sql`
    SELECT wallet_version, direction, amount::text AS amount,
           balance_before::text AS before, balance_after::text AS after
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version`;
  const [sum] = await sql`
    SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text
           AS rebuilt
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;

  expect(sum.rebuilt).toBe(wallet.balance);
  let previousAfter = '0.00';
  for (const entry of entries) {
    expect(entry.before).toBe(previousAfter);
    previousAfter = entry.after;
  }
  if (entries.length > 0) {
    expect(entries.at(-1).wallet_version).toBe(wallet.version);
    const versions = entries.map((entry: { wallet_version: number }) => entry.wallet_version);
    const first = versions[0];
    expect(versions).toEqual(versions.map((_: number, index: number) => first + index));
  }
}
