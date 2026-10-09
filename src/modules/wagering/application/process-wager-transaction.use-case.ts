import { Inject, Injectable } from '@nestjs/common';
import { LockTimeoutError } from '../../../shared/application/errors';
import {
  CLOCK,
  type Clock,
  type DuplicateType,
  FAULT_INJECTOR,
  type FaultInjector,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  type Metrics,
  type RequestMeta,
  type Source,
  type TransactionScope,
  UNIT_OF_WORK,
  UniqueConstraintViolation,
  type UnitOfWork,
} from '../../../shared/application/ports';
import { FailureCode } from '../../../shared/domain/failure-code';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WalletNotFoundError } from '../../wallet/application/errors';
import { payloadHash } from '../domain/payload-hash';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import { IdempotencyKeyMismatchError, IdempotencyPayloadMismatchError } from './errors';
import { toWagerResult, type WagerResultView } from './transaction-views';
import { WagerProcessor } from './wager-processor';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/** Desfecho para o consumidor SQS: ele decide ack ou DLQ por aqui. */
export type QueueOutcome =
  | { kind: 'decided' | 'replay'; result: WagerResultView }
  | { kind: 'conflict'; failureCode: FailureCode; transactionId: string }
  | { kind: 'duplicate_message' }
  /** Mesmo messageId com payload diferente: anomalia do produtor (D-14) → DLQ. */
  | { kind: 'inbox_payload_mismatch' };

/** Unicidades que, numa corrida rara, significam "a outra requisição venceu": reler e responder. */
const RETRYABLE_UNIQUE = new Set(['uq_tx_idempotency_key', 'uq_tx_provider_external']);

type Outcome =
  | { type: 'decided'; transaction: WagerTransaction }
  | { type: 'replay'; transaction: WagerTransaction }
  | { type: 'conflict'; duplicate: DuplicateType; transaction: WagerTransaction }
  | { type: 'duplicate_message' }
  | { type: 'inbox_payload_mismatch' };

/**
 * Entrada única de transações financeiras — a API HTTP e o consumidor SQS usam o mesmo
 * núcleo (§10). Tudo acontece sob o lock da wallet: inbox, idempotência, decisão, ledger,
 * auditoria e outbox são confirmados juntos ou nada é.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
    private readonly processor: WagerProcessor,
  ) {}

  /** Entrada HTTP: resultado da transação, ou 409 em conflito de idempotência. */
  async execute(command: ProcessWagerCommand, meta: RequestMeta): Promise<WagerResultView> {
    const outcome = await this.run(command, { ...meta, source: meta.source ?? 'HTTP' });
    switch (outcome.type) {
      case 'decided':
        return toWagerResult(outcome.transaction, false);
      case 'replay':
        return toWagerResult(outcome.transaction, true);
      case 'conflict':
        throw conflictError(outcome.duplicate, outcome.transaction.id);
      default:
        throw new Error(`desfecho de fila numa entrada HTTP: ${outcome.type}`);
    }
  }

  /** Entrada SQS: nunca lança por regra de negócio; o consumidor decide ack/DLQ pelo desfecho. */
  async executeFromQueue(
    command: ProcessWagerCommand,
    meta: RequestMeta & { inbox: NonNullable<RequestMeta['inbox']> },
  ): Promise<QueueOutcome> {
    const outcome = await this.run(command, { ...meta, source: 'SQS' });
    switch (outcome.type) {
      case 'decided':
        return { kind: 'decided', result: toWagerResult(outcome.transaction, false) };
      case 'replay':
        return { kind: 'replay', result: toWagerResult(outcome.transaction, true) };
      case 'conflict':
        return {
          kind: 'conflict',
          failureCode: conflictError(outcome.duplicate, outcome.transaction.id).code,
          transactionId: outcome.transaction.id,
        };
      case 'duplicate_message':
        return { kind: 'duplicate_message' };
      case 'inbox_payload_mismatch':
        return { kind: 'inbox_payload_mismatch' };
    }
  }

  private async run(command: ProcessWagerCommand, meta: RequestMeta & { source: Source }) {
    try {
      return await this.attempt(command, meta);
    } catch (error) {
      if (error instanceof UniqueConstraintViolation && RETRYABLE_UNIQUE.has(error.constraint)) {
        return this.attempt(command, meta);
      }
      if (error instanceof LockTimeoutError) this.metrics.lockTimeout();
      throw error;
    }
  }

  private async attempt(
    command: ProcessWagerCommand,
    meta: RequestMeta & { source: Source },
  ): Promise<Outcome> {
    const startedAt = performance.now();
    const now = this.clock.now();
    // validação de contrato antes de tocar o banco (400 / DLQ sem lock)
    const hash = payloadHash(command);
    const transaction = WagerTransaction.create({
      ...command,
      id: this.ids.next(),
      payloadHash: hash,
      money: Money.from(command.money),
      createdAt: now,
    });

    const outcome = await this.uow.run<Outcome>(async (scope) => {
      if (meta.inbox) {
        const registration = await scope.inbox.register(meta.inbox);
        if (registration.status === 'DUPLICATE') {
          return registration.existing.matchesPayload(meta.inbox.payloadHash)
            ? { type: 'duplicate_message' }
            : { type: 'inbox_payload_mismatch' };
        }
      }

      const lockStartedAt = performance.now();
      const wallet = await scope.wallets.lockById(command.walletId);
      this.metrics.lockWait((performance.now() - lockStartedAt) / 1000);

      const existing = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        if (existing.matchesPayload(hash)) {
          this.auditDuplicate(scope, existing, now, meta, 'IDEMPOTENT_REPLAY');
          return { type: 'replay', transaction: existing };
        }
        this.auditDuplicate(scope, existing, now, meta, 'IDEMPOTENCY_CONFLICT', {
          failureCode: FailureCode.IdempotencyPayloadMismatch,
          details: { receivedPayloadHash: hash, storedPayloadHash: existing.payloadHash },
        });
        return { type: 'conflict', duplicate: 'payload_conflict', transaction: existing };
      }

      const sameOperation = await scope.transactions.findByProviderExternal(
        command.providerId,
        command.externalTransactionId,
      );
      if (sameOperation) {
        this.auditDuplicate(scope, sameOperation, now, meta, 'IDEMPOTENCY_CONFLICT', {
          failureCode: FailureCode.IdempotencyKeyMismatch,
          details: { reason: 'idempotency_key_mismatch' },
        });
        return { type: 'conflict', duplicate: 'key_mismatch', transaction: sameOperation };
      }

      if (!wallet) {
        throw new WalletNotFoundError('wallet não encontrada', { walletId: command.walletId });
      }

      await this.processor.decide({ scope, wallet, transaction, now, meta });
      scope.transactions.add(transaction);
      this.faults.trigger('wager.before-commit');
      return { type: 'decided', transaction };
    });

    this.record(outcome, meta.source, (performance.now() - startedAt) / 1000);
    return outcome;
  }

  private record(outcome: Outcome, source: Source, seconds: number): void {
    switch (outcome.type) {
      case 'replay':
        this.metrics.duplicate({ source, type: 'idempotent_replay' });
        return;
      case 'conflict':
        this.metrics.duplicate({ source, type: outcome.duplicate });
        return;
      case 'duplicate_message':
        this.metrics.duplicate({ source, type: 'inbox_duplicate' });
        return;
      case 'inbox_payload_mismatch':
        return;
      case 'decided': {
        const { kind, status, failureCode } = outcome.transaction;
        this.metrics.transaction({ kind, status, source }, seconds);
        if (failureCode) this.metrics.error({ category: 'business', failureCode });
      }
    }
  }

  /** Duplicata/conflito é registrado na linha do tempo da transação original. */
  private auditDuplicate(
    scope: TransactionScope,
    original: WagerTransaction,
    now: Date,
    meta: RequestMeta & { source: Source },
    action: 'IDEMPOTENT_REPLAY' | 'IDEMPOTENCY_CONFLICT',
    extra: { failureCode?: FailureCode; details?: Record<string, unknown> } = {},
  ): void {
    this.processor.audit({ scope, walletId: original.walletId, now, meta }, action, {
      transactionId: original.id,
      fromStatus: original.status,
      toStatus: original.status,
      ...extra,
    });
  }
}

function conflictError(duplicate: DuplicateType, transactionId: string) {
  return duplicate === 'payload_conflict'
    ? new IdempotencyPayloadMismatchError('Idempotency-Key já usada com outro payload', {
        transactionId,
      })
    : new IdempotencyKeyMismatchError('operação já registrada com outra Idempotency-Key', {
        transactionId,
      });
}
