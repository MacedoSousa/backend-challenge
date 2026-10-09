import { InvariantViolationError } from '../../../shared/domain/domain-error';
import type { Money } from '../../../shared/domain/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  /** Versão da wallet produzida por este lançamento: sequência contínua por wallet. */
  walletVersion: number;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento do ledger: imutável por construção (campos readonly + instância congelada,
 * sem métodos de transição). A aritmética é validada na factory.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly walletVersion: number,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter, walletVersion } = entry;

    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new InvariantViolationError(`walletVersion inválida: ${walletVersion}`);
    }
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvariantViolationError('lançamento com moedas diferentes');
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError(`valor do lançamento deve ser positivo: ${money}`);
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvariantViolationError('lançamento produziria saldo negativo');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `lançamento desbalanceado: ${balanceBefore} ${entry.direction} ${money} ≠ ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.walletVersion,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
