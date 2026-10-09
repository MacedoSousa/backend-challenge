import { Inject, Injectable } from '@nestjs/common';
import {
  APP_LOGGER,
  type AppLogger,
  METRICS,
  type Metrics,
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../../../shared/application/ports';
import { WalletNotFoundError } from './errors';
import { LedgerCursor } from './ledger-cursor';
import {
  type LedgerPageView,
  type ReconciliationView,
  toLedgerEntryView,
  toWalletView,
  type WalletView,
} from './wallet-views';

const notFound = (walletId: string) =>
  new WalletNotFoundError('wallet não encontrada', { walletId });

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((scope) => scope.wallets.findById(walletId), {
      readOnly: true,
    });
    if (!wallet) throw notFound(walletId);
    return toWalletView(wallet);
  }
}

export interface ListLedgerQuery {
  walletId: string;
  cursor?: string | undefined;
  limit: number;
}

@Injectable()
export class ListLedgerUseCase {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPageView> {
    const afterVersion = LedgerCursor.decode(query.cursor);
    return this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(query.walletId);
        if (!wallet) throw notFound(query.walletId);

        const page = await scope.ledger.page(wallet.id, afterVersion, query.limit);
        const last = page.entries.at(-1);
        return {
          items: page.entries.map(toLedgerEntryView),
          nextCursor: page.hasMore && last ? LedgerCursor.encode(last.walletVersion) : null,
        };
      },
      { readOnly: true },
    );
  }
}

/**
 * Compara o saldo materializado com o reconstruído pelo ledger. Snapshot único
 * (REPEATABLE READ, somente leitura) evita falso positivo com escrita concorrente (D-12).
 * Divergência é logada, contada em métrica e sinalizada — **nunca corrigida em silêncio**.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const report = await this.uow.run(
      async (scope) => {
        const wallet = await scope.wallets.findById(walletId);
        if (!wallet) throw notFound(walletId);
        const summary = await scope.ledger.summarize(wallet.id, wallet.currency);
        return { wallet, summary };
      },
      { isolation: 'REPEATABLE_READ', readOnly: true },
    );

    const stored = report.wallet.balance;
    const calculated = report.summary.rebuiltBalance;
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    this.metrics.reconciliation(consistent ? 'consistent' : 'inconsistent');
    if (!consistent) {
      this.logger.warn(
        { walletId, checkedEntries: report.summary.entries, alert: 'reconciliation_divergence' },
        'wallet balance diverges from ledger',
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: report.summary.entries,
    };
  }
}
