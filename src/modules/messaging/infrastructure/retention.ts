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
  CLOCK,
  type Clock,
  METRICS,
  type Metrics,
  RETENTION_STORE,
  type RetentionStore,
} from '../../../shared/application/ports';
import { PollingLoop } from '../../../shared/infrastructure/polling-loop';

const DAY_MS = 24 * 60 * 60_000;

/** DELETE em lotes por chave primária; só toca linhas já publicadas/processadas. */
@Injectable()
export class SqlRetentionStore implements RetentionStore {
  constructor(private readonly orm: MikroORM) {}

  async deletePublishedOutbox(olderThan: Date, limit: number): Promise<number> {
    const rows = await this.execute(
      `DELETE FROM outbox_messages WHERE id IN (
         SELECT id FROM outbox_messages
          WHERE published_at IS NOT NULL AND published_at < ?
          LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [olderThan, limit],
    );
    return rows.length;
  }

  async deleteProcessedInbox(olderThan: Date, limit: number): Promise<number> {
    const rows = await this.execute(
      `DELETE FROM inbox_messages WHERE (consumer_name, message_id) IN (
         SELECT consumer_name, message_id FROM inbox_messages
          WHERE processed_at IS NOT NULL AND processed_at < ?
          LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING message_id`,
      [olderThan, limit],
    );
    return rows.length;
  }

  private execute(sql: string, params: unknown[]): Promise<unknown[]> {
    return this.orm.em.fork().getConnection().execute<unknown[]>(sql, params);
  }
}

/** Job de retenção (papel `scheduler`): apaga em lotes até não restar nada vencido. */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(RETENTION_STORE) private readonly store: RetentionStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'retention',
      env.RETENTION_INTERVAL_MS,
      () => this.runOnce(),
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLE.includes('scheduler')) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  /** Uma rodada; devolve `true` se algum lote veio cheio (há mais a apagar). */
  async runOnce(): Promise<boolean> {
    const now = this.clock.now().getTime();
    const limit = this.env.RETENTION_BATCH_SIZE;
    // tabelas independentes: as duas limpezas correm em paralelo
    const [outbox, inbox] = await Promise.all([
      this.store.deletePublishedOutbox(
        new Date(now - this.env.OUTBOX_RETENTION_DAYS * DAY_MS),
        limit,
      ),
      this.store.deleteProcessedInbox(
        new Date(now - this.env.INBOX_RETENTION_DAYS * DAY_MS),
        limit,
      ),
    ]);
    if (outbox) this.metrics.retentionDeleted('outbox_messages', outbox);
    if (inbox) this.metrics.retentionDeleted('inbox_messages', inbox);
    return outbox === limit || inbox === limit;
  }
}
