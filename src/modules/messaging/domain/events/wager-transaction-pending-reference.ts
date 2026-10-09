import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../../wagering/domain/wager-transaction';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Referência ausente: a transação aguarda e será reprocessada pelo worker. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextAttemptAt } = tx;
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      !referenceExternalTransactionId ||
      !nextAttemptAt
    ) {
      throw new InvariantViolationError(`transação ${tx.id} não está PENDING_REFERENCE`);
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}
