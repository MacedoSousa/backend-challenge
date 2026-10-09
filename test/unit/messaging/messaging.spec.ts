import { describe, expect, it } from 'bun:test';
import { WagerTransactionPendingReference } from '../../../src/modules/messaging/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../../src/modules/messaging/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../../src/modules/messaging/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../../src/modules/messaging/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/modules/messaging/domain/inbox-message';
import { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { brl, makeTransaction, processed, T0, T1 } from '../wagering/fixtures';

const ctx = (eventId: string) => ({ eventId, correlationId: 'corr-1', occurredAt: T1 });

function balanceChanged() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    at: T0,
    opening: { transactionId: 'tx-open', entryId: 'entry-open' },
  });
  const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'entry-1', at: T1 });
  return WalletBalanceChanged.from(wallet, entry, { ...ctx('evt-1'), causationId: 'msg-9' });
}

describe('IntegrationEvent', () => {
  describe('UT-E01 envelope', () => {
    it('eventType e version vêm do tipo; dinheiro sai como string', () => {
      expect(balanceChanged().toJSON()).toEqual({
        eventId: 'evt-1',
        eventType: 'WalletBalanceChanged',
        aggregateId: 'wallet-1',
        correlationId: 'corr-1',
        causationId: 'msg-9',
        occurredAt: '2026-10-09T12:00:05.000Z',
        version: 1,
        data: {
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          direction: LedgerDirection.Debit,
          money: { amount: '25.00', currency: 'BRL' },
          balanceBefore: { amount: '100.00', currency: 'BRL' },
          balanceAfter: { amount: '75.00', currency: 'BRL' },
          walletVersion: 2,
        },
      });
    });

    it('o payload é JSON puro e estável (ida e volta sem perda)', () => {
      const json = balanceChanged().toJSON();
      expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    });

    it('data é imutável', () => {
      const event = balanceChanged();
      expect(Object.isFrozen(event.data)).toBe(true);
      expect(Object.isFrozen(event.data.money)).toBe(true);
    });
  });

  it('WagerTransactionProcessed', () => {
    const tx = processed({ kind: Kind.Bet });
    const json = WagerTransactionProcessed.from(tx, ctx('evt-2')).toJSON();
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.aggregateId).toBe(tx.walletId);
    expect(json.data).toMatchObject({
      transactionId: tx.id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
    });
  });

  it('WagerTransactionRejected carrega failureCode e a transação relacionada', () => {
    const tx = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.reject(FailureCode.ReferenceAlreadyReversed, {
      at: T1,
      balanceAfter: brl('10.00'),
      relatedTransactionId: 'tx-winner',
    });
    const { data } = WagerTransactionRejected.from(tx, ctx('evt-3')).toJSON();
    expect(data).toMatchObject({
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      relatedTransactionId: 'tx-winner',
    });
  });

  it('WagerTransactionPendingReference', () => {
    const tx = makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(T1);
    const { data } = WagerTransactionPendingReference.from(tx, ctx('evt-4')).toJSON();
    expect(data).toMatchObject({
      referenceExternalTransactionId: 'bet-1',
      nextAttemptAt: T1.toISOString(),
    });
  });

  it('eventos de transação exigem o estado correspondente', () => {
    expect(() => WagerTransactionProcessed.from(makeTransaction(), ctx('e'))).toThrow(
      InvariantViolationError,
    );
    expect(() => WagerTransactionRejected.from(processed(), ctx('e'))).toThrow(
      InvariantViolationError,
    );
  });
});

describe('OutboxMessage', () => {
  const enqueue = () => OutboxMessage.enqueue(balanceChanged());

  it('enqueue usa eventId como id e grava o envelope serializado', () => {
    const message = enqueue();
    expect(message.id).toBe('evt-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(balanceChanged().toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
  });

  describe('UT-O01 backoff crescente com teto', () => {
    it('1s, 2s, 4s, … até 300s', () => {
      const message = enqueue();
      const delays: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        message.scheduleRetry(T1);
        delays.push(((message.nextAttemptAt?.getTime() ?? 0) - T1.getTime()) / 1000);
      }
      expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
      expect(message.attempts).toBe(12);
    });
  });

  describe('UT-O02 isDue', () => {
    it('respeita nextAttemptAt e deixa de valer depois de publicado', () => {
      const message = enqueue();
      expect(message.isDue(T1)).toBe(true);
      message.scheduleRetry(T1);
      expect(message.isDue(T1)).toBe(false);
      expect(message.isDue(new Date(T1.getTime() + 1_000))).toBe(true);

      message.markPublished(T1);
      expect(message.isPending()).toBe(false);
      expect(message.isDue(new Date(T1.getTime() + 60_000))).toBe(false);
    });
  });

  it('publicar duas vezes a mesma instância é erro de programação', () => {
    const message = enqueue();
    message.markPublished(T1);
    expect(() => message.markPublished(T1)).toThrow(InvariantViolationError);
    expect(() => message.scheduleRetry(T1)).toThrow(InvariantViolationError);
  });
});

describe('InboxMessage', () => {
  const receive = () =>
    InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions',
      payloadHash: 'f'.repeat(64),
      receivedAt: T0,
    });

  it('nasce não processada e marca processamento uma única vez', () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(T1);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T1);
    expect(() => message.markProcessed(T1)).toThrow(InvariantViolationError);
  });

  it('detecta mesmo messageId com payload diferente (D-14)', () => {
    expect(receive().matchesPayload('f'.repeat(64))).toBe(true);
    expect(receive().matchesPayload('0'.repeat(64))).toBe(false);
  });
});
