import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

/** Contrato de borda: valor sempre como string decimal (nunca `number`). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Escala fixa do desafio: 2 casas decimais. Valores ficam em centavos (`bigint`). */
const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Até 18 dígitos inteiros e 1–2 decimais: cabe em NUMERIC(20,2). Sem sinal, expoente ou espaços. */
const AMOUNT_PATTERN = /^(\d{1,18})(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  readonly code = FailureCode.ValidationError;
  readonly category = 'validation';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;
  readonly category = 'business';
}

/**
 * Value Object monetário imutável e exato.
 * `bigint` em unidades mínimas elimina arredondamento de ponto flutuante (ADR-02).
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: rejeita negativos, notação científica, NaN, >2 casas etc. */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props.currency);
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal', { field: 'amount' });
    }
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(`amount inválido: "${props.amount}"`, { field: 'amount' });
    }
    const [, integer = '0', fraction = ''] = match;
    const minorUnits = BigInt(integer) * FACTOR + BigInt(fraction.padEnd(SCALE, '0') || '0');
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Igualdade de valor; moedas diferentes simplesmente não são iguais. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    const sign = this.minorUnits < 0n ? '-' : '';
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const integer = absolute / FACTOR;
    const fraction = (absolute % FACTOR).toString().padStart(SCALE, '0');
    return { amount: `${sign}${integer}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `operação entre moedas diferentes: ${this.currency} e ${other.currency}`,
        { expected: this.currency, received: other.currency },
      );
    }
  }

  private static parseCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`moeda inválida: "${String(currency)}" (ISO-4217)`, {
        field: 'currency',
      });
    }
    return currency;
  }
}
