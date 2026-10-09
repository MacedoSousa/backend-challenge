import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { APP_LOGGER, type AppLogger } from '../../../shared/application/ports';
import { PollingLoop } from '../../../shared/infrastructure/polling-loop';
import { PublishOutboxUseCase } from '../application/publish-outbox.use-case';

/** Publisher da outbox (papel `outbox`): lote cheio → próxima rodada imediata. */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    publishOutbox: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'outbox',
      env.OUTBOX_POLL_INTERVAL_MS,
      async () => (await publishOutbox.runOnce()).claimed >= env.OUTBOX_BATCH_SIZE,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLE.includes('outbox')) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }
}
