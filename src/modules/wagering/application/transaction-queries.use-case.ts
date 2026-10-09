import { Inject, Injectable } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/application/ports';
import { TransactionNotFoundError } from './errors';
import {
  type AuditEntryView,
  type TransactionView,
  toAuditEntryView,
  toTransactionView,
} from './transaction-views';

const notFound = (details: Record<string, unknown>) =>
  new TransactionNotFoundError('transação não encontrada', details);

@Injectable()
export class GetTransactionUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.run((scope) => scope.transactions.findById(transactionId), {
      readOnly: true,
    });
    if (!tx) throw notFound({ transactionId });
    return toTransactionView(tx);
  }

  async byProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    const tx = await this.uow.run(
      (scope) => scope.transactions.findByProviderExternal(providerId, externalTransactionId),
      { readOnly: true },
    );
    if (!tx) throw notFound({ providerId, externalTransactionId });
    return toTransactionView(tx);
  }
}

@Injectable()
export class GetTransactionAuditUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  /** Linha do tempo imutável de decisões sobre a transação (D-18). */
  async execute(transactionId: string): Promise<{ items: AuditEntryView[] }> {
    return this.uow.run(
      async (scope) => {
        const tx = await scope.transactions.findById(transactionId);
        if (!tx) throw notFound({ transactionId });
        const entries = await scope.audit.timeline(transactionId);
        return { items: entries.map(toAuditEntryView) };
      },
      { readOnly: true },
    );
  }
}
