import { DomainError } from '../domain/domain-error';
import { FailureCode } from '../domain/failure-code';

/** Payload de entrada inválido (borda HTTP/SQS). */
export class RequestValidationError extends DomainError {
  readonly code = FailureCode.ValidationError;
  readonly category = 'validation';
}

/** Postgres/SQS indisponível ou timeout: o cliente pode tentar de novo. */
export class InfrastructureUnavailableError extends DomainError {
  readonly code = FailureCode.InfraUnavailable;
  readonly category = 'transient';
}

/** Espera pelo lock da wallet esgotada (`lock_timeout`): sinal de hot wallet. */
export class LockTimeoutError extends InfrastructureUnavailableError {}
