import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env';
import { LOGGER } from '../../shared/infrastructure/logging/logging.module';
import { queueUrl } from '../../shared/infrastructure/sqs/queues';
import { SQS_CLIENT } from '../../shared/infrastructure/sqs/sqs.module';
import { Public } from '../auth/public.decorator';

const CHECK_TIMEOUT_MS = 2_000;

type CheckStatus = 'up' | 'down';
export interface ReadinessReport {
  status: CheckStatus;
  checks: { postgres: CheckStatus; sqs: CheckStatus };
}

@Injectable()
export class ReadinessService {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.probe('postgres', () => this.em.getConnection().execute('SELECT 1')),
      this.probe('sqs', async () => {
        const url = await queueUrl(this.sqs, this.env.SQS_WAGER_QUEUE);
        if (!url) throw new Error(`fila ${this.env.SQS_WAGER_QUEUE} não existe`);
        await this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
          { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS) },
        );
      }),
    ]);
    return { status: postgres === 'up' && sqs === 'up' ? 'up' : 'down', checks: { postgres, sqs } };
  }

  private async probe(name: string, fn: () => Promise<unknown>): Promise<CheckStatus> {
    try {
      await withTimeout(fn(), CHECK_TIMEOUT_MS);
      return 'up';
    } catch (error) {
      this.logger.warn({ check: name, err: error }, 'readiness check failed');
      return 'down';
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout após ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Processo vivo: não depende de nada externo. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'up' } {
    return { status: 'up' };
  }

  /** Pronto para receber tráfego: PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    res.status(report.status === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}

@Module({ controllers: [HealthController], providers: [ReadinessService] })
export class HealthModule {}
