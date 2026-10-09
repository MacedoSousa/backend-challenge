import { describe, expect, it } from 'bun:test';
import {
  InsufficientFundsError,
  ReversalInsufficientFundsError,
  Wallet,
  WalletPlayerMismatchError,
} from '../../../src/modules/wallet/domain/wallet';
import { LedgerDirection } from '../../../src/modules/wallet/domain/wallet-ledger-entry';
import { InvariantViolationError } from '../../../src/shared/domain/domain-error';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { CurrencyMismatchError, Money } from '../../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-10-09T12:00:00.000Z');
const t1 = new Date('2026-10-09T12:00:01.000Z');

const openWallet = (initial: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    at: t0,
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
  });

const movement = (n: number, cause: 'WAGER' | 'REVERSAL' = 'WAGER') => ({
  transactionId: `tx-${n}`,
  entryId: `entry-${n}`,
  at: t1,
  cause,
});

describe('Wallet', () => {
  describe('UT-W01 abertura com saldo zero', () => {
    it('version 1 e nenhum lançamento', () => {
      const { wallet, openingEntry } = openWallet('0.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.currency).toBe('BRL');
      expect(openingEntry).toBeUndefined();
    });
  });

  describe('UT-W02 abertura com saldo inicial', () => {
    it('version 1 e um CREDIT de abertura 0 → saldo', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.walletVersion).toBe(1);
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.balanceBefore.isZero()).toBe(true);
      expect(openingEntry?.balanceAfter.equals(brl('100.00'))).toBe(true);
    });

    it('rejeita saldo inicial negativo', () => {
      expect(() =>
        Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: brl('1.00').negate(),
          at: t0,
          opening: { transactionId: 't', entryId: 'e' },
        }),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('UT-W03 débito válido', () => {
    it('reduz o saldo, incrementa version e devolve o lançamento correspondente', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit(brl('80.00'), movement(1));

      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(t1);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletVersion).toBe(2);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('UT-W04 débito acima do saldo', () => {
    it('lança INSUFFICIENT_FUNDS e não altera o estado', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit(brl('80.00'), movement(1));

      const attempt = () => wallet.debit(brl('80.00'), movement(2));
      expect(attempt).toThrow(InsufficientFundsError);
      try {
        attempt();
      } catch (error) {
        expect((error as InsufficientFundsError).code).toBe(FailureCode.InsufficientFunds);
      }
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });
  });

  describe('UT-W05 débito que zera o saldo', () => {
    it('é permitido', () => {
      const { wallet } = openWallet('100.00');
      wallet.debit(brl('100.00'), movement(1));
      expect(wallet.balance.isZero()).toBe(true);
    });
  });

  describe('UT-W06 moeda diferente', () => {
    it.each(['debit', 'credit'] as const)(
      '%s em USD numa wallet BRL lança CURRENCY_MISMATCH',
      (op) => {
        const { wallet } = openWallet('100.00');
        expect(() =>
          wallet[op](Money.from({ amount: '1.00', currency: 'USD' }), movement(1)),
        ).toThrow(CurrencyMismatchError);
        expect(wallet.version).toBe(1);
      },
    );
  });

  describe('UT-W07 rehydrate', () => {
    it('reconstrói o estado persistido sem revalidar', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-9',
        playerId: 'player-9',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 7,
        createdAt: t0,
        updatedAt: t1,
      });
      expect(wallet.version).toBe(7);
      expect(wallet.balance.equals(brl('42.00'))).toBe(true);
    });
  });

  describe('UT-W08 reversão sem saldo', () => {
    it('usa um código distinto de aposta sem saldo', () => {
      const { wallet } = openWallet('10.00');
      expect(() => wallet.debit(brl('25.00'), movement(1, 'REVERSAL'))).toThrow(
        ReversalInsufficientFundsError,
      );
      try {
        wallet.debit(brl('25.00'), movement(1, 'REVERSAL'));
      } catch (error) {
        expect((error as ReversalInsufficientFundsError).code).toBe(
          FailureCode.ReversalInsufficientFunds,
        );
      }
    });
  });

  describe('crédito', () => {
    it('aumenta o saldo e gera CREDIT', () => {
      const { wallet } = openWallet('10.00');
      const entry = wallet.credit(brl('15.50'), movement(1));
      expect(wallet.balance.equals(brl('25.50'))).toBe(true);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.walletVersion).toBe(2);
    });

    it.each(['debit', 'credit'] as const)('%s de valor zero é erro de programação', (op) => {
      const { wallet } = openWallet('10.00');
      expect(() => wallet[op](brl('0.00'), movement(1))).toThrow(InvariantViolationError);
    });
  });

  describe('sequência do ledger', () => {
    it('cada lançamento encadeia no anterior e a versão não tem buracos', () => {
      const { wallet, openingEntry } = openWallet('100.00');
      const entries = [
        openingEntry,
        wallet.debit(brl('30.00'), movement(1)),
        wallet.credit(brl('50.00'), movement(2)),
        wallet.debit(brl('20.00'), movement(3)),
      ].filter((entry) => entry !== undefined);

      entries.forEach((entry, index) => {
        expect(entry.walletVersion).toBe(index + 1);
        const previous = entries[index - 1];
        if (previous) expect(entry.balanceBefore.equals(previous.balanceAfter)).toBe(true);
      });
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  describe('dono da wallet', () => {
    it('assertBelongsTo aceita o dono e rejeita outro jogador', () => {
      const { wallet } = openWallet('10.00');
      expect(() => wallet.assertBelongsTo('player-1')).not.toThrow();
      expect(() => wallet.assertBelongsTo('player-2')).toThrow(WalletPlayerMismatchError);
    });
  });
});
