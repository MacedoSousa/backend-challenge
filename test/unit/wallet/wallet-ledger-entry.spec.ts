import { describe, expect, it } from 'bun:test';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-09T12:00:00.000Z');

const valid = {
  id: 'entry-1',
  walletId: 'wallet-1',
  walletVersion: 2,
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: at,
};

describe('WalletLedgerEntry', () => {
  it('cria lançamentos balanceados de débito e crédito', () => {
    expect(WalletLedgerEntry.create(valid).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create({
      ...valid,
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    });
    expect(credit.isBalanced()).toBe(true);
  });

  describe('UT-L01 a factory rejeita lançamentos inconsistentes', () => {
    it.each([
      ['aritmética errada', { balanceAfter: brl('80.00') }],
      ['direção invertida', { direction: LedgerDirection.Credit }],
      ['valor zero', { money: brl('0.00'), balanceAfter: brl('100.00') }],
      [
        'saldo resultante negativo',
        { balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() },
      ],
      ['moeda diferente', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
      ['versão inválida', { walletVersion: 0 }],
      ['versão não inteira', { walletVersion: 1.5 }],
    ])('%s', (_case, override) => {
      expect(() => WalletLedgerEntry.create({ ...valid, ...override })).toThrow(
        InvariantViolationError,
      );
    });
  });

  describe('UT-L02 imutabilidade estrutural', () => {
    it('a instância é congelada', () => {
      expect(Object.isFrozen(WalletLedgerEntry.create(valid))).toBe(true);
    });

    it('não expõe setters nem métodos de transição', () => {
      const entry = WalletLedgerEntry.create(valid);
      // @ts-expect-error campos são readonly: a atribuição não compila
      expect(() => (entry.balanceAfter = brl('0.00'))).toThrow(TypeError);
      const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
        (name) => name !== 'constructor',
      );
      expect(methods.sort()).toEqual(['isBalanced']);
    });
  });

  it('rehydrate reconstrói sem revalidar', () => {
    const entry = WalletLedgerEntry.rehydrate({ ...valid, balanceAfter: brl('1.00') });
    expect(entry.isBalanced()).toBe(false);
  });
});
