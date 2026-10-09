import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQL } from 'bun';
import { RetentionWorker } from '../../src/modules/messaging/infrastructure/retention';
import { type RunningApp, startApp } from './support/app';
import { connect, uuid } from './support/database';
import { startTestEnvironment, type TestEnvironment } from './support/environment';
import { brl, createWallet, submit, wager } from './support/wagering';

let infra: TestEnvironment;
let api: RunningApp;
let sql: SQL;

beforeAll(async () => {
  infra = await startTestEnvironment({ RETENTION_BATCH_SIZE: '2' });
  api = await startApp(infra.env);
  sql = connect(infra.env);
});

afterAll(async () => {
  await sql?.close();
  await api?.close();
  await infra?.stop();
});

const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

describe('IT-26 retenção (S-2)', () => {
  it('apaga só outbox publicada e inbox processada além do prazo; ledger e auditoria intactos', async () => {
    const wallet = await createWallet(api.url, '100.00');
    await submit(api.url, wager(wallet, { money: brl('10.00') }));

    // 4 eventos da wallet: 2 publicados há 8 dias, 1 publicado ontem, 1 pendente antigo
    const events =
      await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${wallet.walletId} ORDER BY id`;
    expect(events).toHaveLength(4);
    const [oldA, oldB, recent, pending] = events.map((e: { id: string }) => e.id);
    await sql`UPDATE outbox_messages SET published_at = now() - interval '8 days' WHERE id IN (${oldA}, ${oldB})`;
    await sql`UPDATE outbox_messages SET published_at = now() - interval '1 day' WHERE id = ${recent}`;
    await sql`UPDATE outbox_messages SET occurred_at = now() - interval '30 days' WHERE id = ${pending}`;

    // inbox: processada há 16 dias (vence), há 10 dias (dentro dos 15) e uma sem processamento
    const inbox = (id: string, processedDaysAgo: number | null) => sql`
      INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
      VALUES ('wager-transactions', ${id}, ${'a'.repeat(64)}, now() - interval '20 days',
              ${processedDaysAgo === null ? null : sql`now() - ${`${processedDaysAgo} days`}::interval`})`;
    const [expired, kept, unprocessed] = [uuid(), uuid(), uuid()];
    await inbox(expired, 16);
    await inbox(kept, 10);
    await inbox(unprocessed, null);

    const ledgerBefore = await count(sql`SELECT count(*)::int AS n FROM wallet_ledger_entries`);
    const auditBefore = await count(sql`SELECT count(*)::int AS n FROM wager_transaction_audit`);

    // lote de 2: a primeira rodada vem cheia (há mais), a segunda termina
    const worker = api.app.get(RetentionWorker);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);

    const remaining =
      await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ${wallet.walletId}`;
    expect(remaining.map((r: { id: string }) => r.id).sort()).toEqual([recent, pending].sort());
    const inboxLeft = await sql`
      SELECT message_id FROM inbox_messages WHERE message_id IN (${expired}, ${kept}, ${unprocessed})`;
    expect(inboxLeft.map((r: { message_id: string }) => r.message_id).sort()).toEqual(
      [kept, unprocessed].sort(),
    );

    expect(await count(sql`SELECT count(*)::int AS n FROM wallet_ledger_entries`)).toBe(
      ledgerBefore,
    );
    expect(await count(sql`SELECT count(*)::int AS n FROM wager_transaction_audit`)).toBe(
      auditBefore,
    );

    const metrics = await (await fetch(`${api.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_retention_deleted_total\{table="outbox_messages"\} 2/);
    expect(metrics).toMatch(/wagering_retention_deleted_total\{table="inbox_messages"\} 1/);
  });

  it('a configuração recusa reter a inbox por menos que a retenção do SQS (15 dias)', async () => {
    const { loadEnv, InvalidEnvironmentError } = await import('../../src/config/env');
    expect(() =>
      loadEnv({ DATABASE_URL: infra.env.DATABASE_URL, INBOX_RETENTION_DAYS: '7' }),
    ).toThrow(InvalidEnvironmentError);
  });
});
