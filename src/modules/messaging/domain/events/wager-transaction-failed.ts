import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import type { FailureCode } from '../../../../shared/domain/failure-code';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../../wagering/domain/wager-transaction';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WagerTransactionFailedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  failureCode: FailureCode;
  failedAt: string;
}

/**
 * Transação terminal por falha permanente de infraestrutura (§6.3): a mensagem esgotou as
 * tentativas da fila sem nunca ser decidida. Nenhum saldo foi movido; o provedor decide se
 * reenvia como nova operação.
 */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    const { failureCode, processedAt } = tx;
    if (tx.status !== WagerTransactionStatus.Failed || !failureCode || !processedAt) {
      throw new InvariantViolationError(`transação ${tx.id} não está FAILED`);
    }
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        failureCode,
        failedAt: processedAt.toISOString(),
      },
    });
  }
}
