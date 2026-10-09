import { InvariantViolationError } from '../../../../shared/domain/domain-error';
import type { MoneyProps } from '../../../../shared/domain/money';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../../../wagering/domain/wager-transaction';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: 'PROCESSED';
  money: MoneyProps;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const { processedAt, balanceAfter } = tx;
    if (tx.status !== WagerTransactionStatus.Processed || !processedAt || !balanceAfter) {
      throw new InvariantViolationError(`transação ${tx.id} não está PROCESSED`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        status: 'PROCESSED',
        money: tx.money.toJSON(),
        balanceAfter: balanceAfter.toJSON(),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
