import { describe, expect, it } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { Money } from '../../../src/shared/domain/money';

const T0 = new Date('2026-10-09T12:00:00.000Z');
const T1 = new Date('2026-10-09T12:00:30.000Z');

/** O banco devolve o estado; `rehydrate` precisa reconstruí-lo sem perda (§6.0). */
describe('reidratação de inbox e outbox', () => {
  it('InboxMessage: ida e volta preserva todos os campos e o estado de processamento', () => {
    const original = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'c'.repeat(64),
      receivedAt: T0,
    });
    original.markProcessed(T1);

    const copy = InboxMessage.rehydrate({
      messageId: original.messageId,
      consumerName: original.consumerName,
      payloadHash: original.payloadHash,
      receivedAt: original.receivedAt,
      processedAt: original.processedAt,
    });
    expect(copy.messageId).toBe('msg-1');
    expect(copy.consumerName).toBe('wager-transactions');
    expect(copy.payloadHash).toBe('c'.repeat(64));
    expect(copy.receivedAt).toEqual(T0);
    expect(copy.processedAt).toEqual(T1);
    expect(copy.isProcessed()).toBe(true);
  });

  it('InboxMessage: datas expostas são cópias (o estado interno não vaza)', () => {
    const inbox = InboxMessage.receive({
      messageId: 'm',
      consumerName: 'c',
      payloadHash: 'd'.repeat(64),
      receivedAt: T0,
    });
    inbox.receivedAt.setFullYear(1999);
    expect(inbox.receivedAt).toEqual(T0);
  });

  it('OutboxMessage: ida e volta preserva tentativas, agenda e envelope', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      at: T0,
      opening: { transactionId: 'tx-1', entryId: 'entry-1' },
    });
    if (!openingEntry) throw new Error('esperava lançamento');
    const original = OutboxMessage.enqueue(
      WalletBalanceChanged.from(wallet, openingEntry, {
        eventId: 'evt-1',
        correlationId: 'corr',
        occurredAt: T0,
      }),
    );
    original.scheduleRetry(T1);

    const copy = OutboxMessage.rehydrate({
      id: original.id,
      aggregateId: original.aggregateId,
      eventType: original.eventType,
      payload: original.payload,
      occurredAt: original.occurredAt,
      attempts: original.attempts,
      nextAttemptAt: original.nextAttemptAt ?? T0,
      publishedAt: original.publishedAt,
    });
    expect(copy.attempts).toBe(1);
    expect(copy.nextAttemptAt).toEqual(new Date(T1.getTime() + 1_000));
    expect(copy.occurredAt).toEqual(T0);
    expect(copy.payload).toEqual(original.payload);
    expect(copy.isPending()).toBe(true);
    expect(copy.publishedAt).toBeUndefined();

    copy.markPublished(T1);
    expect(copy.publishedAt).toEqual(T1);
    expect(copy.nextAttemptAt).toBeUndefined(); // publicado não tem próxima tentativa
  });
});
