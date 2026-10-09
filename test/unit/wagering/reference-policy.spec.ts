import { describe, expect, it } from 'bun:test';
import { ReferencePolicy } from '../../../src/modules/wagering/domain/reference-policy';
import { WagerTransactionKind as Kind } from '../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { Money } from '../../../src/shared/domain/money';
import { brl, makeTransaction, processed, T1 } from './fixtures';

const policy = new ReferencePolicy();
const reversal = (kind: Kind.Refund | Kind.Rollback, overrides = {}) =>
  makeTransaction({ kind, referenceExternalTransactionId: 'bet-1', ...overrides });

describe('ReferencePolicy — fluxo único de reversão', () => {
  it('transação sem referência é aplicada direto', () => {
    expect(policy.evaluate({ transaction: makeTransaction() })).toEqual({ type: 'APPLY' });
  });

  it('referência ausente → aguardar (PENDING_REFERENCE)', () => {
    expect(policy.evaluate({ transaction: reversal(Kind.Refund) })).toEqual({ type: 'WAIT' });
  });

  describe('UT-T16 REFUND e ROLLBACK seguem o mesmo fluxo', () => {
    it.each([Kind.Refund, Kind.Rollback] as const)('%s de uma BET válida → APPLY', (kind) => {
      const bet = processed({ kind: Kind.Bet });
      expect(policy.evaluate({ transaction: reversal(kind), reference: bet })).toEqual({
        type: 'APPLY',
        reference: bet,
      });
    });
  });

  describe('UT-T10 tipo de referência', () => {
    it.each([
      [Kind.Refund, Kind.Win],
      [Kind.Refund, Kind.Refund],
      [Kind.Refund, Kind.Loss],
      [Kind.Rollback, Kind.Loss],
      [Kind.Rollback, Kind.Rollback],
    ] as const)('%s referenciando %s → REFERENCE_INVALID_KIND', (kind, referenceKind) => {
      const reference = processed({ kind: referenceKind, referenceExternalTransactionId: 'x' });
      expect(policy.evaluate({ transaction: reversal(kind), reference })).toMatchObject({
        type: 'REJECT',
        code: FailureCode.ReferenceInvalidKind,
      });
    });

    it.each([Kind.Bet, Kind.Win, Kind.Refund])('ROLLBACK aceita %s', (referenceKind) => {
      const reference = processed({ kind: referenceKind, referenceExternalTransactionId: 'x' });
      expect(policy.evaluate({ transaction: reversal(Kind.Rollback), reference }).type).toBe(
        'APPLY',
      );
    });

    it('WIN/LOSS só podem referenciar BET', () => {
      const win = makeTransaction({ kind: Kind.Win, referenceExternalTransactionId: 'w' });
      const reference = processed({ kind: Kind.Win });
      expect(policy.evaluate({ transaction: win, reference })).toMatchObject({
        code: FailureCode.ReferenceInvalidKind,
      });
    });
  });

  describe('UT-T11 referência de outro contexto', () => {
    it.each([
      ['provider', { providerId: 'provider-b' }],
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['rodada', { roundId: 'round-2' }],
      ['moeda', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ])('%s diferente → REFERENCE_MISMATCH', (_field, override) => {
      const bet = processed({ kind: Kind.Bet, ...override });
      expect(policy.evaluate({ transaction: reversal(Kind.Refund), reference: bet })).toMatchObject(
        { type: 'REJECT', code: FailureCode.ReferenceMismatch },
      );
    });
  });

  describe('UT-T12 valor', () => {
    it('reversão com valor diferente da referência → AMOUNT_MISMATCH', () => {
      const bet = processed({ kind: Kind.Bet, money: brl('1000.00') });
      expect(
        policy.evaluate({
          transaction: reversal(Kind.Refund, { money: brl('10.00') }),
          reference: bet,
        }),
      ).toMatchObject({ type: 'REJECT', code: FailureCode.AmountMismatch });
    });

    it('WIN pode ter valor diferente da BET referenciada', () => {
      const bet = processed({ kind: Kind.Bet, money: brl('10.00') });
      const win = makeTransaction({
        kind: Kind.Win,
        referenceExternalTransactionId: 'bet-1',
        money: brl('500.00'),
      });
      expect(policy.evaluate({ transaction: win, reference: bet }).type).toBe('APPLY');
    });
  });

  describe('UT-T13/T17 reversão única, por qualquer tipo (D-01)', () => {
    it.each([
      [Kind.Refund, Kind.Rollback],
      [Kind.Rollback, Kind.Refund],
      [Kind.Refund, Kind.Refund],
    ] as const)(
      '%s após %s já processado → REFERENCE_ALREADY_REVERSED apontando o vencedor',
      (kind, winnerKind) => {
        const bet = processed({ kind: Kind.Bet });
        const winner = processed({ kind: winnerKind, referenceExternalTransactionId: 'bet-1' });
        expect(
          policy.evaluate({
            transaction: reversal(kind),
            reference: bet,
            existingReversal: winner,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceAlreadyReversed,
          relatedTransactionId: winner.id,
        });
      },
    );
  });

  describe('UT-T14/T15 estado da referência', () => {
    it('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
      const bet = makeTransaction({ kind: Kind.Bet });
      bet.reject(FailureCode.InsufficientFunds, { at: T1, balanceAfter: brl('0.00') });
      expect(policy.evaluate({ transaction: reversal(Kind.Refund), reference: bet })).toMatchObject(
        { type: 'REJECT', code: FailureCode.ReferenceNotProcessed },
      );
    });

    it('referência ainda PENDING_REFERENCE → continua aguardando (D-15)', () => {
      const refund = makeTransaction({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
      refund.markPendingReference(T1);
      expect(policy.evaluate({ transaction: reversal(Kind.Rollback), reference: refund })).toEqual({
        type: 'WAIT',
      });
    });
  });
});
