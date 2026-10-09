import { describe, expect, it } from 'bun:test';
import type { Env } from '../../../src/config/env';
import { PublishOutboxUseCase } from '../../../src/modules/messaging/application/publish-outbox.use-case';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import type {
  MessagePublisher,
  Metrics,
  OutboxStore,
  PublishResult,
} from '../../../src/shared/application/ports';
import { Money } from '../../../src/shared/domain/money';

const NOW = new Date('2026-10-09T12:00:00.000Z');

function message(n: number): OutboxMessage {
  const { wallet, openingEntry } = Wallet.open({
    id: `wallet-${n}`,
    playerId: 'player',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    at: NOW,
    opening: { transactionId: `tx-${n}`, entryId: `entry-${n}` },
  });
  if (!openingEntry) throw new Error('esperava lançamento de abertura');
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, openingEntry, {
      eventId: `evt-${n}`,
      correlationId: 'corr',
      occurredAt: NOW,
    }),
  );
}

/** Dublês em memória: o comportamento real (SQL, SQS) é coberto em test/integration/outbox.spec.ts. */
function setup(
  options: { publish?: (m: OutboxMessage[]) => PublishResult; faultPoints?: string[] } = {},
) {
  const pending = [message(1), message(2), message(3)];
  const marked: string[] = [];
  const rescheduled: OutboxMessage[] = [];
  const calls = { retries: 0, published: 0, lag: [] as number[] };

  const store: OutboxStore = {
    claimDue: async ({ limit }) => pending.splice(0, limit),
    markPublished: async (ids) => {
      marked.push(...ids);
      return ids.length;
    },
    reschedule: async (m) => {
      rescheduled.push(m);
    },
    lagSeconds: async () => 7,
  };
  const publisher: MessagePublisher = {
    publish: async (messages) =>
      options.publish?.(messages) ?? { published: messages.map((m) => m.id), failed: [] },
  };
  const metrics = {
    outboxPublished: (n: number) => {
      calls.published += n;
    },
    retry: () => {
      calls.retries += 1;
    },
    outboxLag: (s: number) => calls.lag.push(s),
  } as unknown as Metrics;
  const logger = { info() {}, warn() {}, error() {} };
  const faults = {
    trigger(point: string) {
      if (options.faultPoints?.includes(point)) throw new Error(`falha em ${point}`);
    },
  };
  const env = { OUTBOX_LEASE_MS: 30_000, OUTBOX_BATCH_SIZE: 2 } as Env;

  const useCase = new PublishOutboxUseCase(
    store,
    publisher,
    { now: () => NOW },
    metrics,
    logger,
    faults,
    'instance-1',
    env,
  );
  return { useCase, marked, rescheduled, calls };
}

describe('PublishOutboxUseCase', () => {
  it('publica o lote reservado e marca como publicado', async () => {
    const { useCase, marked, calls } = setup();
    expect(await useCase.runOnce()).toEqual({ claimed: 2, published: 2, retried: 0 });
    expect(marked).toEqual(['evt-1', 'evt-2']);
    expect(calls.published).toBe(2);
    expect(calls.lag).toEqual([7]);
  });

  it('o que falhou é reagendado com backoff (attempts + 1) e conta retry', async () => {
    const { useCase, marked, rescheduled, calls } = setup({
      publish: (messages) => ({
        published: [messages[0]?.id ?? ''],
        failed: [{ id: messages[1]?.id ?? '', reason: 'Throttled' }],
      }),
    });
    expect(await useCase.runOnce()).toEqual({ claimed: 2, published: 1, retried: 1 });
    expect(marked).toEqual(['evt-1']);
    expect(rescheduled.map((m) => [m.id, m.attempts, m.nextAttemptAt?.toISOString()])).toEqual([
      ['evt-2', 1, '2026-10-09T12:00:01.000Z'],
    ]);
    expect(calls.retries).toBe(1);
  });

  it('processo "morre" depois de publicar: nada é marcado e o lease decide quem republica', async () => {
    const { useCase, marked, rescheduled } = setup({
      faultPoints: ['outbox.after-publish-before-mark'],
    });
    await expect(useCase.runOnce()).rejects.toThrow('outbox.after-publish-before-mark');
    expect(marked).toEqual([]);
    expect(rescheduled).toEqual([]);
  });

  it('sem eventos vencidos: só atualiza o lag', async () => {
    const { useCase, calls } = setup();
    await useCase.runOnce();
    await useCase.runOnce(); // consome o terceiro
    expect(await useCase.runOnce()).toEqual({ claimed: 0, published: 0, retried: 0 });
    expect(calls.lag).toHaveLength(3);
  });
});
