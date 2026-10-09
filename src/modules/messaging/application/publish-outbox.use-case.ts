import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  FAULT_INJECTOR,
  type FaultInjector,
  INSTANCE_ID,
  MESSAGE_PUBLISHER,
  METRICS,
  type MessagePublisher,
  type Metrics,
  OUTBOX_STORE,
  type OutboxStore,
} from '../../../shared/application/ports';

export interface PublishRound {
  claimed: number;
  published: number;
  retried: number;
}

/**
 * Uma rodada do publisher (§11): reserva um lote vencido (lease), publica, marca como
 * publicado o que deu certo e reagenda o resto com backoff. Eventos nunca são descartados:
 * se o processo morrer no meio, o lease expira e outra instância assume.
 */
@Injectable()
export class PublishOutboxUseCase {
  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    @Inject(MESSAGE_PUBLISHER) private readonly publisher: MessagePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async runOnce(): Promise<PublishRound> {
    const claimed = await this.store.claimDue({
      instanceId: this.instanceId,
      now: this.clock.now(),
      leaseMs: this.env.OUTBOX_LEASE_MS,
      limit: this.env.OUTBOX_BATCH_SIZE,
    });
    if (claimed.length === 0) {
      this.metrics.outboxLag(await this.store.lagSeconds(this.clock.now()));
      return { claimed: 0, published: 0, retried: 0 };
    }

    const result = await this.publisher.publish(claimed);
    // simula o processo morrendo entre publicar e marcar (CT-05/CT-06)
    this.faults.trigger('outbox.after-publish-before-mark');

    const marked = await this.store.markPublished(
      result.published,
      this.instanceId,
      this.clock.now(),
    );
    this.metrics.outboxPublished(marked);

    const failedIds = new Set(result.failed.map((failure) => failure.id));
    const failed = claimed.filter((message) => failedIds.has(message.id));
    for (const message of failed) {
      message.scheduleRetry(this.clock.now());
      await this.store.reschedule(message, this.instanceId);
      this.metrics.retry('outbox');
    }
    if (failed.length > 0) {
      this.logger.warn(
        {
          failed: failed.length,
          reasons: [...new Set(result.failed.map((f) => f.reason))],
          alert: 'outbox_publish_failed',
        },
        'outbox publish failed; rescheduled with backoff',
      );
    }

    this.metrics.outboxLag(await this.store.lagSeconds(this.clock.now()));
    return { claimed: claimed.length, published: marked, retried: failed.length };
  }
}
