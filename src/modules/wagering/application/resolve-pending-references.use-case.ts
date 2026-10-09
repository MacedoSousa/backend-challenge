import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  CLOCK,
  type Clock,
  METRICS,
  type Metrics,
  PENDING_REFERENCE_STORE,
  type PendingReferenceClaim,
  type PendingReferenceStore,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../shared/application/ports';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { WagerProcessor } from './wager-processor';

export type ResolutionOutcome = 'PROCESSED' | 'REJECTED' | 'RETRY_SCHEDULED' | 'SKIPPED';

export interface ResolutionRound {
  claimed: number;
  outcomes: ResolutionOutcome[];
}

/**
 * Worker do §7.1: reserva as transações PENDING_REFERENCE vencidas (lease) e, para cada
 * uma, **primeiro** tenta resolver a referência pelo mesmo `WagerProcessor` da entrada; só
 * se ela continuar ausente aplica a `ReferenceRetryPolicy` (retry com backoff ou expiração).
 */
@Injectable()
export class ResolvePendingReferencesUseCase {
  constructor(
    @Inject(PENDING_REFERENCE_STORE) private readonly store: PendingReferenceStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly env: Env,
    private readonly processor: WagerProcessor,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async runOnce(): Promise<ResolutionRound> {
    const claims = await this.store.claimDue({
      now: this.clock.now(),
      leaseMs: this.env.PENDING_WORKER_LEASE_MS,
      limit: this.env.PENDING_WORKER_BATCH_SIZE,
    });
    const outcomes: ResolutionOutcome[] = [];
    // uma pendência por vez: cada uma trava a sua wallet; workers paralelos dividem o lote
    for (const claim of claims) outcomes.push(await this.resolve(claim));
    this.metrics.pendingReferences(await this.store.count());
    return { claimed: claims.length, outcomes };
  }

  private async resolve(claim: PendingReferenceClaim): Promise<ResolutionOutcome> {
    const startedAt = performance.now();
    return this.uow.run(async (scope) => {
      const now = this.clock.now();
      const wallet = await scope.wallets.lockById(claim.walletId);
      const transaction = await scope.transactions.findById(claim.transactionId);
      // já resolvida por outra rodada (ou dados inconsistentes): nada a fazer
      if (!wallet || transaction?.status !== WagerTransactionStatus.PendingReference) {
        return 'SKIPPED';
      }

      const input = {
        scope,
        wallet,
        transaction,
        now,
        meta: {
          correlationId: transaction.id,
          causationId: transaction.id,
          source: 'WORKER' as const,
        },
      };
      let outcome: ResolutionOutcome;
      const decision = await this.processor.decide(input);
      if (decision === 'WAITING') {
        const next = this.retryPolicy.decide(transaction, now);
        if (next.type === 'RETRY') {
          this.processor.scheduleRetry(input, next.nextAttemptAt);
          this.metrics.retry('pending_worker');
          outcome = 'RETRY_SCHEDULED';
        } else {
          await this.processor.expire(input, next.reason);
          outcome = 'REJECTED';
        }
      } else {
        outcome = decision === 'PROCESSED' ? 'PROCESSED' : 'REJECTED';
      }

      scope.transactions.save(transaction);
      if (outcome !== 'RETRY_SCHEDULED') {
        this.metrics.transaction(
          { kind: transaction.kind, status: transaction.status, source: 'WORKER' },
          (performance.now() - startedAt) / 1000,
        );
      }
      return outcome;
    });
  }
}
