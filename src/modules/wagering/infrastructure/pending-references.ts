import { MikroORM } from '@mikro-orm/postgresql';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  APP_LOGGER,
  type AppLogger,
  type PendingReferenceClaim,
  type PendingReferenceStore,
} from '../../../shared/application/ports';
import { PollingLoop } from '../../../shared/infrastructure/polling-loop';
import { ResolvePendingReferencesUseCase } from '../application/resolve-pending-references.use-case';

/**
 * Claim com lease: adia `next_attempt_at` das pendências reservadas. Se o worker morrer,
 * o prazo vence e outra instância as retoma; `SKIP LOCKED` evita disputa entre instâncias.
 */
@Injectable()
export class SqlPendingReferenceStore implements PendingReferenceStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue({ now, leaseMs, limit }: Parameters<PendingReferenceStore['claimDue']>[0]) {
    const rows = await this.execute<{ id: string; wallet_id: string }>(
      `UPDATE wager_transactions t
          SET next_attempt_at = ?::timestamptz + (? * interval '1 millisecond')
        WHERE t.id IN (
              SELECT id FROM wager_transactions
               WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
               ORDER BY next_attempt_at
               LIMIT ?
               FOR UPDATE SKIP LOCKED)
       RETURNING t.id, t.wallet_id`,
      [now, leaseMs, now, limit],
    );
    return rows.map(
      (row): PendingReferenceClaim => ({ transactionId: row.id, walletId: row.wallet_id }),
    );
  }

  async count(): Promise<number> {
    const [row] = await this.execute<{ n: number }>(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
      [],
    );
    return row?.n ?? 0;
  }

  private execute<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.orm.em.fork().getConnection().execute<T[]>(sql, params);
  }
}

/** Worker de referências pendentes (papel `scheduler`). */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    resolve: ResolvePendingReferencesUseCase,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'pending_worker',
      env.PENDING_WORKER_INTERVAL_MS,
      async () => (await resolve.runOnce()).claimed >= env.PENDING_WORKER_BATCH_SIZE,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLE.includes('scheduler')) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }
}
