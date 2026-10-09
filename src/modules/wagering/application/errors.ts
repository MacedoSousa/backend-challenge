import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';

/** Mesma Idempotency-Key com payload diferente: conflito, nunca replay (§9). */
export class IdempotencyPayloadMismatchError extends DomainError {
  readonly code = FailureCode.IdempotencyPayloadMismatch;
  readonly category = 'conflict';
}

/** Mesmo (providerId, externalTransactionId) já registrado com outra Idempotency-Key (D-04). */
export class IdempotencyKeyMismatchError extends DomainError {
  readonly code = FailureCode.IdempotencyKeyMismatch;
  readonly category = 'conflict';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = FailureCode.TransactionNotFound;
  readonly category = 'business';
}
