import type { FailureCode } from './failure-code';

/**
 * Categoria decide o tratamento na borda (HTTP / consumidor SQS):
 * - validation: payload inválido, nada é persistido
 * - conflict:   conflito de idempotência ou unicidade
 * - business:   regra de negócio; vira transação REJECTED quando há agregado
 * - transient:  infraestrutura indisponível, pode tentar de novo
 * - permanent:  infraestrutura falhou de forma definitiva
 */
export type ErrorCategory = 'validation' | 'conflict' | 'business' | 'transient' | 'permanent';

/** Erro esperado do domínio, com código estável. */
export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;
  abstract readonly category: ErrorCategory;

  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Violação de invariante = erro de programação (não é caminho de negócio).
 * Ex.: transicionar uma transação já terminal, montar um lançamento desbalanceado.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
