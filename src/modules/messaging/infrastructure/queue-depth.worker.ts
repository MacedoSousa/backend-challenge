import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
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
  METRICS,
  type Metrics,
} from '../../../shared/application/ports';
import { PollingLoop } from '../../../shared/infrastructure/polling-loop';
import { queueUrl } from '../../../shared/infrastructure/sqs/queues';
import { SQS_CLIENT } from '../../../shared/infrastructure/sqs/sqs.module';

const DEPTH_ATTRIBUTES = [
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
] as const;

/**
 * Profundidade das filas como métrica (papel `scheduler`). Existe porque o redrive para a DLQ
 * acontece dentro do SQS, sem passar pela aplicação: o contador de envios à DLQ não o vê, a
 * profundidade da DLQ vê (revisão técnica, divergência 2). Na AWS seria o CloudWatch
 * (`ApproximateNumberOfMessagesVisible`); aqui, com LocalStack, a aplicação publica.
 */
@Injectable()
export class QueueDepthWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(APP_LOGGER) logger: AppLogger,
  ) {
    this.loop = new PollingLoop(
      'queue-depth',
      env.QUEUE_DEPTH_INTERVAL_MS,
      async () => {
        await this.runOnce();
        return false;
      },
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLE.includes('scheduler')) this.loop.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.loop.stop();
  }

  async runOnce(): Promise<void> {
    const queues = {
      wager: this.env.SQS_WAGER_QUEUE,
      wager_dlq: this.env.SQS_WAGER_DLQ,
      events: this.env.SQS_EVENTS_QUEUE,
    };
    await Promise.all(
      Object.entries(queues).map(async ([label, name]) => {
        const url = await queueUrl(this.sqs, name);
        if (!url) return;
        const { Attributes = {} } = await this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: [...DEPTH_ATTRIBUTES] }),
        );
        const total = DEPTH_ATTRIBUTES.reduce(
          (sum, attribute) => sum + Number.parseInt(Attributes[attribute] ?? '0', 10),
          0,
        );
        this.metrics.queueDepth(label, total);
      }),
    );
  }
}
