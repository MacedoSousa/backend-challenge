import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';

export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;
  readonly category = 'business';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = FailureCode.WalletAlreadyExists;
  readonly category = 'conflict';
}
