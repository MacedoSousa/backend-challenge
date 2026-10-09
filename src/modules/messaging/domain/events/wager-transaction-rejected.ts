import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import type { FailureCode } from '../../../../shared/domain/failure-code';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../../wagering/domain/wager-transaction';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  failureCode: FailureCode;
  /** Ex.: a reversão vencedora em REFERENCE_ALREADY_REVERSED. */
  relatedTransactionId?: string;
  rejectedAt: string;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const { failureCode, processedAt } = tx;
    if (tx.status !== WagerTransactionStatus.Rejected || !failureCode || !processedAt) {
      throw new InvariantViolationError(`transação ${tx.id} não está REJECTED`);
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        failureCode,
        ...(tx.relatedTransactionId ? { relatedTransactionId: tx.relatedTransactionId } : {}),
        rejectedAt: processedAt.toISOString(),
      },
    });
  }
}
