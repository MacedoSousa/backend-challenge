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

/** Unicidades que, numa corrida rara, significam "a outra requisição venceu": reler e responder. */
const RETRYABLE_UNIQUE = new Set(['uq_tx_idempotency_key', 'uq_tx_provider_external']);

type Outcome =
  | { type: 'decided'; transaction: WagerTransaction }
  | { type: 'replay'; transaction: WagerTransaction }
  | { type: 'conflict'; duplicate: DuplicateType; transaction: WagerTransaction };

/**
 * Entrada única de transações financeiras — usada pela API HTTP e pelo consumidor SQS (§10).
 * Tudo acontece sob o lock da wallet: idempotência, decisão, ledger, auditoria e outbox
 * são confirmados juntos ou nada é.
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

  async execute(command: ProcessWagerCommand, meta: RequestMeta): Promise<WagerResultView> {
    const source: Source = meta.source ?? 'HTTP';
    try {
      return await this.attempt(command, { ...meta, source });
    } catch (error) {
      if (error instanceof UniqueConstraintViolation && RETRYABLE_UNIQUE.has(error.constraint)) {
        return this.attempt(command, { ...meta, source });
      }
      if (error instanceof LockTimeoutError) this.metrics.lockTimeout();
      throw error;
    }
  }

  private async attempt(
    command: ProcessWagerCommand,
    meta: RequestMeta & { source: Source },
  ): Promise<WagerResultView> {
    const startedAt = performance.now();
    const now = this.clock.now();
    // validação de contrato antes de tocar o banco (400 sem lock)
    const hash = payloadHash(command);
    const transaction = WagerTransaction.create({
      ...command,
      id: this.ids.next(),
      payloadHash: hash,
      money: Money.from(command.money),
      createdAt: now,
    });

    const outcome = await this.uow.run<Outcome>(async (scope) => {
      const lockStartedAt = performance.now();
      const wallet = await scope.wallets.lockById(command.walletId);
      this.metrics.lockWait((performance.now() - lockStartedAt) / 1000);

      const existing = await scope.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (existing) {
        const replay = existing.matchesPayload(hash);
        if (replay) {
          this.auditDuplicate(scope, existing, now, meta, 'IDEMPOTENT_REPLAY');
        } else {
          this.auditDuplicate(scope, existing, now, meta, 'IDEMPOTENCY_CONFLICT', {
            failureCode: FailureCode.IdempotencyPayloadMismatch,
            details: { receivedPayloadHash: hash, storedPayloadHash: existing.payloadHash },
          });
        }
        return replay
          ? { type: 'replay', transaction: existing }
          : { type: 'conflict', duplicate: 'payload_conflict', transaction: existing };
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

    const elapsed = (performance.now() - startedAt) / 1000;
    switch (outcome.type) {
      case 'replay':
        this.metrics.duplicate({ source: meta.source, type: 'idempotent_replay' });
        return toWagerResult(outcome.transaction, true);
      case 'conflict':
        this.metrics.duplicate({ source: meta.source, type: outcome.duplicate });
        throw outcome.duplicate === 'payload_conflict'
          ? new IdempotencyPayloadMismatchError('Idempotency-Key já usada com outro payload', {
              transactionId: outcome.transaction.id,
            })
          : new IdempotencyKeyMismatchError('operação já registrada com outra Idempotency-Key', {
              transactionId: outcome.transaction.id,
            });
      case 'decided':
        this.metrics.transaction(
          {
            kind: outcome.transaction.kind,
            status: outcome.transaction.status,
            source: meta.source,
          },
          elapsed,
        );
        if (outcome.transaction.failureCode) {
          this.metrics.error({
            category: 'business',
            failureCode: outcome.transaction.failureCode,
          });
        }
        return toWagerResult(outcome.transaction, false);
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
