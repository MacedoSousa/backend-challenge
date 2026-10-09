import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { APP_LOGGER, type AppLogger } from '../../../shared/application/ports';
import { PublishOutboxUseCase } from '../application/publish-outbox.use-case';

/**
 * Laço do publisher (papel `outbox`): enquanto houver lote cheio, segue sem pausa;
 * sem trabalho, espera `OUTBOX_POLL_INTERVAL_MS`. No shutdown termina a rodada em curso.
 */
@Injectable()
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.APP_ROLE.includes('outbox')) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ component: 'outbox' }, 'outbox publisher started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let fullBatch = false;
      try {
        const round = await this.publishOutbox.runOnce();
        fullBatch = round.claimed >= this.env.OUTBOX_BATCH_SIZE;
      } catch (error) {
        // inclui falha injetada: o lease fica e expira, como num processo morto
        this.logger.error({ err: error, component: 'outbox' }, 'outbox round failed');
      }
      if (!fullBatch) await this.sleep(this.env.OUTBOX_POLL_INTERVAL_MS);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
