import type { AppLogger } from '../application/ports';

/**
 * Laço de varredura dos workers: enquanto `tick` indicar mais trabalho, segue sem pausa;
 * sem trabalho, espera `intervalMs`. `stop()` interrompe a espera e aguarda o tick em curso.
 */
export class PollingLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly component: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ component: this.component }, `${this.component} started`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let moreWork = false;
      try {
        moreWork = await this.tick();
      } catch (error) {
        // inclui falha injetada: estado em andamento fica com o lease, como num processo morto
        this.logger.error(
          { err: error, component: this.component },
          `${this.component} round failed`,
        );
      }
      if (!moreWork && this.running) await this.sleep(this.intervalMs);
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
