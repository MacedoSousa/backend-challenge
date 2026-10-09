/**
 * Códigos de falha estáveis e legíveis por máquina (docs/01 §7).
 * O provedor decide pelo código se reenvia, corrige o payload ou desiste.
 */
export enum FailureCode {
  ValidationError = 'VALIDATION_ERROR',
  OpeningNotAllowed = 'OPENING_NOT_ALLOWED',
  ReferenceRequired = 'REFERENCE_REQUIRED',

  IdempotencyPayloadMismatch = 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  IdempotencyKeyMismatch = 'IDEMPOTENCY_KEY_MISMATCH',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',

  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Reservado (D-19): só usado se uma PlayerSessionPolicy restritiva for ativada. */
  ConcurrentGameNotAllowed = 'CONCURRENT_GAME_NOT_ALLOWED',

  InfraUnavailable = 'INFRA_UNAVAILABLE',
  InfraRetriesExhausted = 'INFRA_RETRIES_EXHAUSTED',
}
