import { describe, expect, it } from 'bun:test';
import {
  InvalidTransactionStateError,
  WagerTransactionKind as Kind,
  OpeningNotAllowedError,
  ReferenceRequiredError,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { DomainError, InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { brl, makeTransaction, processed, T1 } from './fixtures';

describe('WagerTransaction', () => {
  describe('UT-T01 criação', () => {
    it('nasce PENDING, sem processedAt nem failureCode', () => {
      const tx = makeTransaction();
      expect(tx.status).toBe(Status.Pending);
      expect(tx.processedAt).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
      expect(tx.isTerminal()).toBe(false);
    });
  });

  describe('UT-T02 referência obrigatória', () => {
    it.each([Kind.Refund, Kind.Rollback])('%s sem referência é rejeitado', (kind) => {
      expect(() => makeTransaction({ kind })).toThrow(ReferenceRequiredError);
    });

    it.each([Kind.Win, Kind.Loss])('%s aceita referência opcional', (kind) => {
      expect(() => makeTransaction({ kind })).not.toThrow();
      expect(() =>
        makeTransaction({ kind, referenceExternalTransactionId: 'bet-1' }),
      ).not.toThrow();
    });
  });

  describe('UT-T03 OPENING é interno', () => {
    it('create() recusa OPENING', () => {
      expect(() => makeTransaction({ kind: Kind.Opening })).toThrow(OpeningNotAllowedError);
    });

    it('createOpening() monta a transação interna', () => {
      const tx = WagerTransaction.createOpening({
        id: 'tx-open',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        payloadHash: 'b'.repeat(64),
        createdAt: T1,
      });
      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.providerId).toBe('internal');
      expect(tx.idempotencyKey).toBe('internal:opening:wallet-1');
      expect(tx.roundId).toBeUndefined();
    });
  });

  describe('validação de entrada', () => {
    it.each([
      ['BET de valor zero', { money: brl('0.00') }],
      ['valor negativo', { money: brl('1.00').negate() }],
      ['roundId vazio', { roundId: '' }],
      ['gameId vazio', { gameId: '' }],
      ['providerId vazio', { providerId: '' }],
      ['payloadHash fora do formato SHA-256', { payloadHash: 'xyz' }],
    ])('%s', (_case, override) => {
      try {
        makeTransaction(override);
        throw new Error('deveria ter lançado');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(FailureCode.ValidationError);
      }
    });

    it('LOSS aceita valor zero (D-07)', () => {
      expect(() => makeTransaction({ kind: Kind.Loss, money: brl('0.00') })).not.toThrow();
    });
  });

  describe('UT-T04 transições válidas', () => {
    it('PENDING → PROCESSED guarda snapshot do saldo, referência e horário', () => {
      const tx = makeTransaction();
      tx.markProcessed({ at: T1, balanceAfter: brl('75.00'), referenceTransactionId: 'tx-ref' });
      expect(tx.status).toBe(Status.Processed);
      expect(tx.processedAt).toEqual(T1);
      expect(tx.balanceAfter?.equals(brl('75.00'))).toBe(true);
      expect(tx.referenceTransactionId).toBe('tx-ref');
    });

    it('PENDING → REJECTED guarda código, snapshot e transação relacionada', () => {
      const tx = makeTransaction();
      tx.reject(FailureCode.InsufficientFunds, {
        at: T1,
        balanceAfter: brl('20.00'),
        relatedTransactionId: 'tx-winner',
      });
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.relatedTransactionId).toBe('tx-winner');
    });

    it('PENDING → FAILED', () => {
      const tx = makeTransaction();
      tx.fail(FailureCode.InfraRetriesExhausted, T1);
      expect(tx.status).toBe(Status.Failed);
    });

    it('PENDING → PENDING_REFERENCE → retry → PROCESSED', () => {
      const tx = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
      tx.markPendingReference(T1);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.attempts).toBe(0);
      expect(tx.nextAttemptAt).toEqual(T1);

      const later = new Date(T1.getTime() + 2_000);
      tx.scheduleReferenceRetry(later);
      expect(tx.attempts).toBe(1);
      expect(tx.nextAttemptAt).toEqual(later);

      tx.markProcessed({
        at: later,
        balanceAfter: brl('100.00'),
        referenceTransactionId: 'tx-bet',
      });
      expect(tx.status).toBe(Status.Processed);
      expect(tx.nextAttemptAt).toBeUndefined();
    });

    it('PENDING_REFERENCE → REJECTED (TTL esgotado)', () => {
      const tx = makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'bet-1' });
      tx.markPendingReference(T1);
      tx.reject(FailureCode.ReferenceNotFound, { at: T1, balanceAfter: brl('10.00') });
      expect(tx.status).toBe(Status.Rejected);
    });
  });

  describe('UT-T05 estados terminais', () => {
    const terminals = () => {
      const p = makeTransaction();
      p.markProcessed({ at: T1, balanceAfter: brl('1.00') });
      const r = makeTransaction();
      r.reject(FailureCode.InsufficientFunds, { at: T1, balanceAfter: brl('1.00') });
      const f = makeTransaction();
      f.fail(FailureCode.InfraRetriesExhausted, T1);
      return [p, r, f];
    };

    it('qualquer transição a partir de terminal lança InvalidTransactionStateError', () => {
      for (const tx of terminals()) {
        expect(tx.isTerminal()).toBe(true);
        expect(() => tx.markProcessed({ at: T1, balanceAfter: brl('1.00') })).toThrow(
          InvalidTransactionStateError,
        );
        expect(() =>
          tx.reject(FailureCode.InsufficientFunds, { at: T1, balanceAfter: brl('1.00') }),
        ).toThrow(InvalidTransactionStateError);
        expect(() => tx.fail(FailureCode.InfraRetriesExhausted, T1)).toThrow(
          InvalidTransactionStateError,
        );
        expect(() => tx.markPendingReference(T1)).toThrow(InvalidTransactionStateError);
      }
    });

    it('InvalidTransactionStateError é erro de programação, não de negócio', () => {
      expect(new InvalidTransactionStateError('x')).toBeInstanceOf(InvariantViolationError);
    });

    it('retry só existe em PENDING_REFERENCE', () => {
      expect(() => makeTransaction().scheduleReferenceRetry(T1)).toThrow(
        InvalidTransactionStateError,
      );
    });

    it('reject/fail exigem códigos coerentes com a categoria', () => {
      expect(() =>
        makeTransaction().reject(FailureCode.InfraUnavailable, {
          at: T1,
          balanceAfter: brl('1.00'),
        }),
      ).toThrow(InvariantViolationError);
      expect(() => makeTransaction().fail(FailureCode.InsufficientFunds, T1)).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('UT-T06 affectsBalance', () => {
    it.each([
      [Kind.Bet, true],
      [Kind.Win, true],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('%s → %p', (kind, expected) => {
      const tx = makeTransaction({ kind, referenceExternalTransactionId: 'bet-1' });
      expect(tx.affectsBalance()).toBe(expected);
    });
  });

  describe('UT-T07 direção do lançamento', () => {
    const bet = processed({ kind: Kind.Bet });
    const win = processed({ kind: Kind.Win });
    const refund = processed({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });

    it.each([
      ['BET', makeTransaction({ kind: Kind.Bet }), undefined, LedgerDirection.Debit],
      ['WIN', makeTransaction({ kind: Kind.Win }), undefined, LedgerDirection.Credit],
      [
        'REFUND(BET)',
        makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }),
        bet,
        LedgerDirection.Credit,
      ],
      [
        'ROLLBACK(BET)',
        makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' }),
        bet,
        LedgerDirection.Credit,
      ],
      [
        'ROLLBACK(WIN)',
        makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'w' }),
        win,
        LedgerDirection.Debit,
      ],
      [
        'ROLLBACK(REFUND)',
        makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' }),
        refund,
        LedgerDirection.Debit,
      ],
    ])('%s → %s', (_name, tx, reference, expected) => {
      expect(tx.ledgerDirectionFor(reference)).toBe(expected);
    });

    it('LOSS não gera lançamento', () => {
      expect(() => makeTransaction({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
        InvariantViolationError,
      );
    });

    it('reversão sem a referência resolvida é erro de programação', () => {
      const tx = makeTransaction({ kind: Kind.Rollback, referenceExternalTransactionId: 'b' });
      expect(() => tx.ledgerDirectionFor()).toThrow(InvariantViolationError);
    });
  });

  describe('UT-T08 matchesPayload', () => {
    it('compara o hash do payload', () => {
      const tx = makeTransaction({ payloadHash: 'c'.repeat(64) });
      expect(tx.matchesPayload('c'.repeat(64))).toBe(true);
      expect(tx.matchesPayload('d'.repeat(64))).toBe(false);
    });
  });

  it('rehydrate reconstrói estado terminal sem revalidar', () => {
    const original = makeTransaction();
    original.reject(FailureCode.InsufficientFunds, { at: T1, balanceAfter: brl('1.00') });
    const copy = WagerTransaction.rehydrate(original.toState());
    expect(copy.status).toBe(Status.Rejected);
    expect(copy.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(copy.balanceAfter?.equals(brl('1.00'))).toBe(true);
  });
});
