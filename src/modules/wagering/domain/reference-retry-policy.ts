import { InvariantViolationError } from '../../../shared/domain/domain-error';

export interface ReferenceRetryOptions {
  /** Atraso da primeira tentativa e base do backoff exponencial. */
  baseDelayMs: number;
  /** Teto do atraso entre tentativas. */
  maxDelayMs: number;
  /** Total de tentativas de resolver a referência (inclui a primeira). */
  maxAttempts: number;
  /** Idade máxima da transação pendente, protege contra worker parado. */
  ttlMs: number;
  /** Acréscimo aleatório de até `jitterRatio` × atraso, para espalhar as retentativas. */
  jitterRatio: number;
  /** Fonte de aleatoriedade em [0, 1); injetável para testes determinísticos. */
  random: () => number;
}

/**
 * Valores justificados no ADR-12: provedores reenviam a referência em segundos, então
 * 10 tentativas em ~4 min cobrem o caso normal; o TTL de 15 min é a rede de segurança
 * quando o worker ficou parado. Pendência longa atrasa a reconciliação do provedor.
 */
export const DEFAULT_REFERENCE_RETRY: ReferenceRetryOptions = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 10,
  ttlMs: 15 * 60_000,
  jitterRatio: 0.2,
  random: Math.random,
};

export type RetryDecision =
  | { type: 'RETRY'; nextAttemptAt: Date }
  | { type: 'EXPIRE'; reason: 'MAX_ATTEMPTS' | 'TTL' };

/** Estado mínimo de uma transação PENDING_REFERENCE para decidir o próximo passo. */
export interface PendingReferenceState {
  attempts: number;
  createdAt: Date;
}

/**
 * Política de reprocessamento de referências fora de ordem (§7.1). Pura: o worker tenta
 * resolver a referência **primeiro** e só consulta a política quando ela ainda não existe.
 */
export class ReferenceRetryPolicy {
  private readonly options: ReferenceRetryOptions;

  constructor(overrides: Partial<ReferenceRetryOptions> = {}) {
    this.options = { ...DEFAULT_REFERENCE_RETRY, ...overrides };
    assertValid(this.options);
  }

  /** Quando fazer a primeira tentativa, ao entrar em PENDING_REFERENCE. */
  firstAttemptAt(now: Date): Date {
    return this.after(now, 0);
  }

  /** Chamado após uma tentativa em que a referência continuou ausente. */
  decide(transaction: PendingReferenceState, now: Date): RetryDecision {
    if (now.getTime() - transaction.createdAt.getTime() >= this.options.ttlMs) {
      return { type: 'EXPIRE', reason: 'TTL' };
    }
    const attemptsMade = transaction.attempts + 1;
    if (attemptsMade >= this.options.maxAttempts) {
      return { type: 'EXPIRE', reason: 'MAX_ATTEMPTS' };
    }
    return { type: 'RETRY', nextAttemptAt: this.after(now, attemptsMade) };
  }

  private after(now: Date, exponent: number): Date {
    const { baseDelayMs, maxDelayMs, jitterRatio, random } = this.options;
    const delay = Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
    const jittered = Math.floor(delay * (1 + jitterRatio * random()));
    return new Date(now.getTime() + jittered);
  }
}

function assertValid(options: ReferenceRetryOptions): void {
  const { baseDelayMs, maxDelayMs, maxAttempts, ttlMs, jitterRatio } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InvariantViolationError(`maxAttempts inválido: ${maxAttempts}`);
  }
  if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs || ttlMs <= 0) {
    throw new InvariantViolationError('atrasos do retry de referência incoerentes');
  }
  if (jitterRatio < 0 || jitterRatio > 1) {
    throw new InvariantViolationError(`jitterRatio deve estar em [0, 1]: ${jitterRatio}`);
  }
}
