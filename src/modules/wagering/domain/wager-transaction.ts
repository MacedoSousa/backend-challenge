import { DomainError, InvariantViolationError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

export const INTERNAL_PROVIDER_ID = 'internal';
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Transições válidas (docs/05 §5). PROCESSED, REJECTED e FAILED são terminais.
 * PENDING é transitório dentro da transação SQL.
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [Status.Pending]: [Status.Processed, Status.Rejected, Status.Failed, Status.PendingReference],
  [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

/** Códigos aceitos em reject(): regras de negócio. */
const BUSINESS_REJECTION_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.WalletPlayerMismatch,
  FailureCode.CurrencyMismatch,
  FailureCode.InsufficientFunds,
  FailureCode.ReversalInsufficientFunds,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceMismatch,
  FailureCode.ReferenceInvalidKind,
  FailureCode.ReferenceNotProcessed,
  FailureCode.ReferenceAlreadyReversed,
  FailureCode.AmountMismatch,
  FailureCode.ConcurrentGameNotAllowed,
]);

/** Códigos aceitos em fail(): falha permanente de infraestrutura. */
const PERMANENT_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.InfraRetriesExhausted,
]);

export class InvalidTransactionError extends DomainError {
  readonly code = FailureCode.ValidationError;
  readonly category = 'validation';
}

export class OpeningNotAllowedError extends DomainError {
  readonly code = FailureCode.OpeningNotAllowed;
  readonly category = 'validation';
}

export class ReferenceRequiredError extends DomainError {
  readonly code = FailureCode.ReferenceRequired;
  readonly category = 'validation';
}

/** Transição a partir de estado terminal (ou inválida): erro de programação. */
export class InvalidTransactionStateError extends InvariantViolationError {}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor da transação referenciada (não o id interno). */
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  relatedTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  /** Saldo observado na decisão: base do replay fiel (D-05). */
  balanceAfter: Money | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
}

export interface ProcessedOutcome {
  at: Date;
  balanceAfter: Money;
  referenceTransactionId?: string | undefined;
}

export interface RejectedOutcome extends ProcessedOutcome {
  /** Ex.: a reversão vencedora quando a referência já foi revertida. */
  relatedTransactionId?: string | undefined;
}

export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  /** Nasce PENDING. Valida o contrato de entrada e a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new OpeningNotAllowedError('OPENING é interno e não pode ser submetido', {
        field: 'kind',
      });
    }
    requireText(props, ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId']);
    requireText(props, ['playerId', 'roundId', 'gameId']);
    assertPayloadHash(props.payloadHash);

    const requiresReference = props.kind === Kind.Refund || props.kind === Kind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(`${props.kind} exige referenceExternalTransactionId`, {
        field: 'referenceExternalTransactionId',
      });
    }
    const zeroAllowed = props.kind === Kind.Loss;
    if (props.money.isNegative() || (!zeroAllowed && props.money.isZero())) {
      throw new InvalidTransactionError(`valor inválido para ${props.kind}: ${props.money}`, {
        field: 'money',
      });
    }

    return new WagerTransaction({
      ...props,
      referenceExternalTransactionId: props.referenceExternalTransactionId || undefined,
      createdAt: new Date(props.createdAt),
      status: Status.Pending,
      referenceTransactionId: undefined,
      relatedTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      balanceAfter: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
    });
  }

  /** Transação interna de abertura da wallet (D-11). */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    assertPayloadHash(props.payloadHash);
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('OPENING só existe para saldo inicial positivo');
    }
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: props.walletId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: undefined,
      gameId: undefined,
      kind: Kind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: new Date(props.createdAt),
      status: Status.Pending,
      referenceTransactionId: undefined,
      relatedTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      balanceAfter: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
    });
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({ ...state });
  }

  get id() {
    return this.state.id;
  }
  get providerId() {
    return this.state.providerId;
  }
  get externalTransactionId() {
    return this.state.externalTransactionId;
  }
  get idempotencyKey() {
    return this.state.idempotencyKey;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get walletId() {
    return this.state.walletId;
  }
  get playerId() {
    return this.state.playerId;
  }
  get roundId() {
    return this.state.roundId;
  }
  get gameId() {
    return this.state.gameId;
  }
  get kind() {
    return this.state.kind;
  }
  get money() {
    return this.state.money;
  }
  get referenceExternalTransactionId() {
    return this.state.referenceExternalTransactionId;
  }
  get createdAt() {
    return new Date(this.state.createdAt);
  }
  get status() {
    return this.state.status;
  }
  get referenceTransactionId() {
    return this.state.referenceTransactionId;
  }
  get relatedTransactionId() {
    return this.state.relatedTransactionId;
  }
  get failureCode() {
    return this.state.failureCode;
  }
  get processedAt() {
    return this.state.processedAt && new Date(this.state.processedAt);
  }
  get balanceAfter() {
    return this.state.balanceAfter;
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt() {
    return this.state.nextAttemptAt && new Date(this.state.nextAttemptAt);
  }

  // ---- transições

  markProcessed(outcome: ProcessedOutcome): void {
    this.transitionTo(Status.Processed);
    this.state.processedAt = new Date(outcome.at);
    this.state.balanceAfter = outcome.balanceAfter;
    this.state.referenceTransactionId = outcome.referenceTransactionId;
    this.state.nextAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.transitionTo(Status.PendingReference);
    this.state.nextAttemptAt = new Date(nextAttemptAt);
  }

  /** Nova tentativa de resolver a referência (worker com backoff). */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this.state.status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(
        `retry de referência exige PENDING_REFERENCE (atual: ${this.state.status})`,
      );
    }
    this.state.attempts += 1;
    this.state.nextAttemptAt = new Date(nextAttemptAt);
  }

  reject(code: FailureCode, outcome: RejectedOutcome): void {
    if (!BUSINESS_REJECTION_CODES.has(code)) {
      throw new InvariantViolationError(`${code} não é um código de rejeição de negócio`);
    }
    this.transitionTo(Status.Rejected);
    this.state.failureCode = code;
    this.state.processedAt = new Date(outcome.at);
    this.state.balanceAfter = outcome.balanceAfter;
    this.state.referenceTransactionId = outcome.referenceTransactionId;
    this.state.relatedTransactionId = outcome.relatedTransactionId;
    this.state.nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    if (!PERMANENT_FAILURE_CODES.has(code)) {
      throw new InvariantViolationError(`${code} não é um código de falha permanente`);
    }
    this.transitionTo(Status.Failed);
    this.state.failureCode = code;
    this.state.processedAt = new Date(at);
    this.state.nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TRANSITIONS[this.state.status].length === 0;
  }

  affectsBalance(): boolean {
    return this.state.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.state.kind === Kind.Refund || this.state.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /** Direção do lançamento; reversões invertem a direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.state.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Opening:
      case Kind.Win:
      // REFUND só referencia BET (débito): o inverso é sempre crédito, então não depende
      // da referência carregada — o que permite calcular ROLLBACK(REFUND).
      case Kind.Refund:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvariantViolationError('LOSS não gera lançamento');
      case Kind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError(`${this.state.kind} exige a referência resolvida`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  toState(): WagerTransactionState {
    return { ...this.state };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this.state.status].includes(next)) {
      throw new InvalidTransactionStateError(
        `transição inválida: ${this.state.status} → ${next} (transação ${this.state.id})`,
      );
    }
    this.state.status = next;
  }
}

function requireText<K extends keyof CreateWagerTransactionProps>(
  props: CreateWagerTransactionProps,
  fields: K[],
): void {
  for (const field of fields) {
    const value = props[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidTransactionError(`${String(field)} é obrigatório`, { field });
    }
  }
}

function assertPayloadHash(payloadHash: string): void {
  if (!PAYLOAD_HASH_PATTERN.test(payloadHash)) {
    throw new InvalidTransactionError('payloadHash deve ser SHA-256 em hexadecimal', {
      field: 'payloadHash',
    });
  }
}
