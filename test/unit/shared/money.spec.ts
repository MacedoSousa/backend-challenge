import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('UT-M01 criação e serialização', () => {
    it('serializa como string decimal com 2 casas e moeda', () => {
      const money = brl('25.00');
      expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(money.toString()).toBe('25.00 BRL');
      expect(money.currency).toBe('BRL');
    });

    it('zero(currency) cria valor nulo', () => {
      expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(Money.zero('BRL').isZero()).toBe(true);
    });
  });

  describe('UT-M02 normalização para escala fixa de 2', () => {
    it.each([
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0.1', '0.10'],
      ['007.00', '7.00'],
      ['0', '0.00'],
    ])('"%s" vira "%s"', (input, expected) => {
      expect(brl(input).toJSON().amount).toBe(expected);
    });
  });

  describe('UT-M03 rejeita entradas inválidas', () => {
    it.each([
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1E3',
      '',
      ' 1',
      '1 ',
      '25.001',
      '-1.00',
      '+1.00',
      '1,00',
      '.50',
      '1.',
      '0x10',
      '1_000',
    ])('rejeita %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejeita amount que não seja string (ex.: number vindo de JSON)', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });
  });

  describe('UT-M04 aritmética exata', () => {
    it('0.10 + 0.20 é exatamente 0.30', () => {
      expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    });

    it('subtrai e pode produzir negativo (resultado interno, não contrato de entrada)', () => {
      expect(brl('10.00').subtract(brl('25.50')).toJSON().amount).toBe('-15.50');
    });

    it('negate inverte o sinal', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
    });
  });

  describe('UT-M05 conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s entre BRL e USD lança CurrencyMismatchError', (_name, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });

    it('equals entre moedas diferentes é false (não lança)', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
    });
  });

  describe('UT-M06 imutabilidade', () => {
    it('operações retornam nova instância sem alterar a original', () => {
      const a = brl('10.00');
      const b = a.add(brl('5.00'));
      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('15.00');
      expect(b).not.toBe(a);
    });

    it('a instância é congelada', () => {
      expect(Object.isFrozen(brl('1.00'))).toBe(true);
    });
  });

  describe('UT-M07 consultas', () => {
    it.each([
      ['0.00', { zero: true, positive: false, negative: false }],
      ['0.01', { zero: false, positive: true, negative: false }],
    ])('%s', (amount, expected) => {
      const money = brl(amount);
      expect(money.isZero()).toBe(expected.zero);
      expect(money.isPositive()).toBe(expected.positive);
      expect(money.isNegative()).toBe(expected.negative);
    });

    it('negativo', () => {
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('isLessThan e equals', () => {
      expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
      expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
      expect(brl('10').equals(brl('10.00'))).toBe(true);
      expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    });
  });

  describe('UT-M08 limites', () => {
    it('aceita 18 dígitos inteiros sem perda de precisão', () => {
      const max = brl('999999999999999999.99');
      expect(max.toJSON().amount).toBe('999999999999999999.99');
      expect(max.add(brl('0.01')).toJSON().amount).toBe('1000000000000000000.00');
    });

    it('rejeita mais de 18 dígitos inteiros (limite de NUMERIC(20,2))', () => {
      expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
    });
  });

  describe('UT-M09 moeda', () => {
    it.each(['BR', 'brl', 'BRLL', '', '12A'])('rejeita moeda %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });
});
