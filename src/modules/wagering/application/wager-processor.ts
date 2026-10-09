import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditAction,
  type AuditEntry,
  ID_GENERATOR,
  type IdGenerator,
  INSTANCE_ID,
  PLAYER_SESSION_POLICY,
  type PlayerSessionPolicy,
  type RequestMeta,
  type Source,
  type TransactionScope,
} from '../../../shared/application/ports';
import { DomainError } from '../../../shared/domain/domain-error';
import { FailureCode } from '../../../shared/domain/failure-code';
import { WagerTransactionFailed } from '../../messaging/domain/events/wager-transaction-failed';
import { WagerTransactionPendingReference } from '../../messaging/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../messaging/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../messaging/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../messaging/domain/events/wallet-balance-changed';
import type { IntegrationEvent } from '../../messaging/domain/integration-event';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import type { Wallet } from '../../wallet/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { ReferencePolicy } from '../domain/reference-policy';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import {
  WagerTransactionKind as Kind,
  type WagerTransaction,
  type WagerTransactionStatus,
} from '../domain/wager-transaction';

export interface DecisionInput {
  scope: TransactionScope;
  /** Já travada (`FOR UPDATE`) pelo chamador. */
  wallet: Wallet;
  transaction: WagerTransaction;
  now: Date;
  meta: RequestMeta & { source: Source };
}

/** `WAITING` = referência ainda ausente numa transação que já estava pendente (worker). */
export type DecisionOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'WAITING';

/**
 * Decide uma transação já travada: dono da wallet, moeda, política de sessão, referência
 * (fluxo único de REFUND/ROLLBACK) e aplicação no saldo. Cada decisão grava auditoria e
 * eventos na outbox **no mesmo scope** (mesma transação SQL). Usado pela entrada HTTP/SQS
 * e pelo worker de referências pendentes.
 */
@Injectable()
export class WagerProcessor {
  private readonly referencePolicy = new ReferencePolicy();

  constructor(
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    @Inject(PLAYER_SESSION_POLICY) private readonly sessionPolicy: PlayerSessionPolicy,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async decide(input: DecisionInput): Promise<DecisionOutcome> {
    const outcome = await this.decideOnce(input);
    if (outcome === 'PROCESSED' || outcome === 'REJECTED') await this.wakeDependents(input);
    return outcome;
  }

  /** Worker: a referência continua ausente e ainda há tentativas (§7.1). */
  scheduleRetry(input: DecisionInput, nextAttemptAt: Date): void {
    const { transaction: tx } = input;
    tx.scheduleReferenceRetry(nextAttemptAt);
    this.audit({ ...input, walletId: input.wallet.id }, 'RETRY_SCHEDULED', {
      transactionId: tx.id,
      fromStatus: tx.status,
      toStatus: tx.status,
      details: { attempts: tx.attempts, nextAttemptAt: nextAttemptAt.toISOString() },
    });
  }

  /** Worker: limite de tentativas ou TTL esgotado → REJECTED REFERENCE_NOT_FOUND + evento. */
  async expire(input: DecisionInput, reason: 'MAX_ATTEMPTS' | 'TTL'): Promise<DecisionOutcome> {
    const outcome = this.reject(
      input,
      input.transaction.status,
      FailureCode.ReferenceNotFound,
      {},
      {
        expiredBy: reason,
        attempts: input.transaction.attempts,
      },
    );
    await this.wakeDependents(input);
    return outcome;
  }

  /**
   * Fila: tentativas esgotadas sem decisão (§6.3, D-09) → `FAILED INFRA_RETRIES_EXHAUSTED`,
   * terminal, auditado e com evento. Não move saldo, então não precisa da wallet travada.
   */
  fail(input: Omit<DecisionInput, 'wallet'>, details: Record<string, unknown>): void {
    const { transaction: tx, now } = input;
    const fromStatus = tx.status;
    tx.fail(FailureCode.InfraRetriesExhausted, now);
    input.scope.outbox.add(
      OutboxMessage.enqueue(WagerTransactionFailed.from(tx, this.eventContext(input))),
    );
    this.audit({ ...input, walletId: tx.walletId }, 'FAILED', {
      transactionId: tx.id,
      fromStatus,
      toStatus: tx.status,
      failureCode: FailureCode.InfraRetriesExhausted,
      details,
    });
  }

  /** Pendentes que aguardavam esta transação são reavaliadas já na próxima rodada do worker. */
  private wakeDependents(input: DecisionInput): Promise<void> {
    const { transaction: tx } = input;
    return input.scope.transactions.wakeDependents(
      tx.providerId,
      tx.externalTransactionId,
      input.now,
    );
  }

  private async decideOnce(input: DecisionInput): Promise<DecisionOutcome> {
    const { wallet, transaction: tx } = input;
    const fromStatus = tx.status;

    if (wallet.playerId !== tx.playerId) {
      return this.reject(input, fromStatus, FailureCode.WalletPlayerMismatch);
    }
    if (wallet.currency !== tx.money.currency) {
      return this.reject(input, fromStatus, FailureCode.CurrencyMismatch);
    }
    if (tx.kind === Kind.Bet && tx.roundId && tx.gameId) {
      const allowed = await this.sessionPolicy.canBet({
        playerId: tx.playerId,
        gameId: tx.gameId,
        roundId: tx.roundId,
      });
      if (!allowed) return this.reject(input, fromStatus, FailureCode.ConcurrentGameNotAllowed);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      // sem lock próprio: a referência válida está na wallet já travada (revisão técnica, div. 7)
      reference = await input.scope.transactions.findByProviderExternal(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
      const existingReversal = reference
        ? await input.scope.transactions.findProcessedReversalOf(reference.id)
        : undefined;
      const decision = this.referencePolicy.evaluate({
        transaction: tx,
        reference,
        existingReversal,
      });

      if (decision.type === 'WAIT') return this.waitForReference(input, fromStatus);
      if (decision.type === 'REJECT') {
        return this.reject(input, fromStatus, decision.code, {
          referenceTransactionId: reference?.id,
          relatedTransactionId: decision.relatedTransactionId,
        });
      }
    }

    return this.apply(input, fromStatus, reference);
  }

  private async apply(
    input: DecisionInput,
    fromStatus: WagerTransactionStatus,
    reference: WagerTransaction | undefined,
  ): Promise<DecisionOutcome> {
    const { scope, wallet, transaction: tx, now } = input;

    let entry: WalletLedgerEntry | undefined;
    if (tx.affectsBalance()) {
      const movement = {
        transactionId: tx.id,
        entryId: this.ids.next(),
        at: now,
        cause: tx.isReversal() ? ('REVERSAL' as const) : ('WAGER' as const),
      };
      try {
        entry =
          tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(tx.money, movement)
            : wallet.credit(tx.money, movement);
      } catch (error) {
        if (error instanceof DomainError && error.category === 'business') {
          return this.reject(input, fromStatus, error.code, {
            referenceTransactionId: reference?.id,
          });
        }
        throw error;
      }
      scope.wallets.save(wallet);
      scope.ledger.append(entry);
    }

    tx.markProcessed({
      at: now,
      balanceAfter: wallet.balance,
      referenceTransactionId: reference?.id,
    });
    this.publish(input, WagerTransactionProcessed.from(tx, this.eventContext(input)));
    if (entry)
      this.publish(input, WalletBalanceChanged.from(wallet, entry, this.eventContext(input)));

    this.audit({ ...input, walletId: input.wallet.id }, 'PROCESSED', {
      transactionId: tx.id,
      fromStatus,
      toStatus: tx.status,
      ledgerEntryId: entry?.id,
      relatedTransactionId: reference?.id,
    });
    if (tx.isReversal() && reference) {
      this.audit({ ...input, walletId: input.wallet.id }, 'REVERSED_BY', {
        transactionId: reference.id,
        fromStatus: reference.status,
        toStatus: reference.status,
        relatedTransactionId: tx.id,
        details: { reversalKind: tx.kind },
      });
    }
    return 'PROCESSED';
  }

  private reject(
    input: DecisionInput,
    fromStatus: WagerTransactionStatus,
    code: FailureCode,
    links: {
      referenceTransactionId?: string | undefined;
      relatedTransactionId?: string | undefined;
    } = {},
    details?: Record<string, unknown>,
  ): DecisionOutcome {
    const { wallet, transaction: tx, now } = input;
    tx.reject(code, { at: now, balanceAfter: wallet.balance, ...links });
    this.publish(input, WagerTransactionRejected.from(tx, this.eventContext(input)));
    this.audit({ ...input, walletId: input.wallet.id }, 'REJECTED', {
      transactionId: tx.id,
      fromStatus,
      toStatus: tx.status,
      failureCode: code,
      relatedTransactionId: links.relatedTransactionId ?? links.referenceTransactionId,
      details,
    });
    return 'REJECTED';
  }

  private waitForReference(
    input: DecisionInput,
    fromStatus: WagerTransactionStatus,
  ): DecisionOutcome {
    const { transaction: tx, now } = input;
    // já pendente: quem decide o próximo passo (retry/expirar) é o worker (§7.1)
    if (fromStatus !== 'PENDING') return 'WAITING';

    tx.markPendingReference(this.retryPolicy.firstAttemptAt(now));
    this.publish(input, WagerTransactionPendingReference.from(tx, this.eventContext(input)));
    this.audit({ ...input, walletId: input.wallet.id }, 'PENDING_REFERENCE', {
      transactionId: tx.id,
      fromStatus,
      toStatus: tx.status,
      details: { referenceExternalTransactionId: tx.referenceExternalTransactionId },
    });
    return 'PENDING_REFERENCE';
  }

  /** Registro de auditoria ligado à wallet travada, com origem e rastreio da requisição. */
  audit(
    input: Pick<DecisionInput, 'scope' | 'now' | 'meta'> & { walletId: string },
    action: AuditAction,
    fields: Omit<
      AuditEntry,
      'id' | 'walletId' | 'action' | 'source' | 'correlationId' | 'instanceId' | 'occurredAt'
    >,
  ): void {
    input.scope.audit.record({
      id: this.ids.next(),
      walletId: input.walletId,
      action,
      source: input.meta.source,
      correlationId: input.meta.correlationId,
      messageId: input.meta.messageId,
      instanceId: this.instanceId,
      occurredAt: input.now,
      ...fields,
    });
  }

  private publish(input: DecisionInput, event: IntegrationEvent<unknown>): void {
    input.scope.outbox.add(OutboxMessage.enqueue(event));
  }

  private eventContext(input: Pick<DecisionInput, 'meta' | 'now'>) {
    return {
      eventId: this.ids.next(),
      correlationId: input.meta.correlationId,
      causationId: input.meta.causationId ?? input.meta.messageId,
      occurredAt: input.now,
    };
  }
}
