import { DomainError, InvariantViolationError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;
  readonly category = 'business';
}

/** Reversão sem saldo: operacionalmente diferente de aposta sem saldo (regra 9). */
export class ReversalInsufficientFundsError extends DomainError {
  readonly code = FailureCode.ReversalInsufficientFunds;
  readonly category = 'business';
}

export class WalletPlayerMismatchError extends DomainError {
  readonly code = FailureCode.WalletPlayerMismatch;
  readonly category = 'business';
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifica o movimento que gera o lançamento. */
export interface LedgerMovement {
  transactionId: string;
  entryId: string;
  at: Date;
  /** Define o código de erro quando falta saldo (padrão: WAGER). */
  cause?: 'WAGER' | 'REVERSAL';
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Ids da transação OPENING e do lançamento; usados só se o saldo inicial for > 0. */
  opening: { transactionId: string; entryId: string };
}

/**
 * Aggregate root: única porta para alterar saldo. Cada alteração devolve o lançamento
 * do ledger correspondente, de modo que saldo e ledger nascem juntos e consistentes.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvariantViolationError(`saldo inicial negativo: ${initialBalance}`);
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at),
      new Date(at),
    );
    if (initialBalance.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: wallet.id,
      walletVersion: 1,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: new Date(at),
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(money: Money, movement: LedgerMovement): WalletLedgerEntry {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      const ErrorType =
        movement.cause === 'REVERSAL' ? ReversalInsufficientFundsError : InsufficientFundsError;
      throw new ErrorType(`saldo insuficiente: saldo ${this._balance}, débito ${money}`, {
        walletId: this.id,
      });
    }
    return this.apply(LedgerDirection.Debit, money, this._balance.subtract(money), movement);
  }

  credit(money: Money, movement: LedgerMovement): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), movement);
  }

  assertBelongsTo(playerId: string): void {
    if (playerId !== this.playerId) {
      throw new WalletPlayerMismatchError('a wallet não pertence ao jogador informado', {
        walletId: this.id,
      });
    }
  }

  /** Monta o lançamento antes de mudar o estado: se a factory falhar, nada é alterado. */
  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    movement: LedgerMovement,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      walletVersion: this._version + 1,
      transactionId: movement.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: new Date(movement.at),
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError(`movimento deve ter valor positivo: ${money}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `moeda da operação (${money.currency}) difere da wallet (${this.currency})`,
        { walletId: this.id, expected: this.currency, received: money.currency },
      );
    }
  }
}
