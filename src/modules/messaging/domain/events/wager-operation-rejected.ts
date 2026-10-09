import type { FailureCode } from '../../../../shared/domain/failure-code';
import { type EventContext, IntegrationEvent } from '../integration-event';

export interface WagerOperationRejectedData {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  failureCode: FailureCode;
  /** Mensagem SQS recusada. */
  messageId: string;
  /** Transação já registrada com a qual a operação conflitou (conflitos de idempotência). */
  originalTransactionId?: string;
  rejectedAt: string;
}

export interface RejectedOperation {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
}

/**
 * Operação recebida pela fila e recusada SEM virar transação própria: conflito de
 * idempotência (criar outra linha com a mesma chave violaria a unicidade) ou wallet
 * inexistente. Pelo HTTP o provedor recebe 409/404 na resposta; pela fila, só por este evento
 * (revisão técnica, divergência 5).
 */
export class WagerOperationRejected extends IntegrationEvent<WagerOperationRejectedData> {
  readonly eventType = 'WagerOperationRejected';
  readonly version = 1;

  static from(
    operation: RejectedOperation,
    rejection: { failureCode: FailureCode; messageId: string; originalTransactionId?: string },
    ctx: EventContext,
  ): WagerOperationRejected {
    return new WagerOperationRejected({
      ...ctx,
      aggregateId: operation.walletId,
      data: {
        providerId: operation.providerId,
        externalTransactionId: operation.externalTransactionId,
        walletId: operation.walletId,
        kind: operation.kind,
        failureCode: rejection.failureCode,
        messageId: rejection.messageId,
        ...(rejection.originalTransactionId
          ? { originalTransactionId: rejection.originalTransactionId }
          : {}),
        rejectedAt: ctx.occurredAt.toISOString(),
      },
    });
  }
}
