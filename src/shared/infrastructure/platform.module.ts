import { Controller, Get, Global, Header, Inject, Injectable, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { Counter, collectDefaultMetrics, Registry } from 'prom-client';
import { Public } from '../../modules/auth/public.decorator';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  type Metrics,
} from '../application/ports';
import { LOGGER } from './logging/logging.module';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}

/** Métricas de negócio (§12) em formato Prometheus, prefixo `wagering_`. */
@Injectable()
export class PrometheusMetrics implements Metrics {
  private readonly reconciliations: Counter<'result'>;
  private readonly divergences: Counter;

  constructor(@Inject(METRICS_REGISTRY) registry: Registry) {
    this.reconciliations = new Counter({
      name: 'wagering_reconciliations_total',
      help: 'Reconciliações executadas, por resultado',
      labelNames: ['result'],
      registers: [registry],
    });
    this.divergences = new Counter({
      name: 'wagering_reconciliation_divergence_total',
      help: 'Wallets cujo saldo diverge do ledger (deve permanecer 0)',
      registers: [registry],
    });
  }

  reconciliation(result: 'consistent' | 'inconsistent'): void {
    this.reconciliations.inc({ result });
    if (result === 'inconsistent') this.divergences.inc();
  }
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}

/** Serviços técnicos transversais: relógio, ids, logger de aplicação e métricas. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: APP_LOGGER, inject: [LOGGER], useFactory: (logger: Logger): AppLogger => logger },
    {
      provide: METRICS_REGISTRY,
      useFactory: () => {
        const registry = new Registry();
        collectDefaultMetrics({ register: registry });
        return registry;
      },
    },
    { provide: METRICS, useClass: PrometheusMetrics },
  ],
  exports: [CLOCK, ID_GENERATOR, APP_LOGGER, METRICS, METRICS_REGISTRY],
})
export class PlatformModule {}
