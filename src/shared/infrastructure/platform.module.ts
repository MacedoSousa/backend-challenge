import { Controller, Get, Global, Header, Inject, Injectable, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env';
import { Public } from '../../modules/auth/public.decorator';
import { InfrastructureUnavailableError } from '../application/errors';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  type DuplicateType,
  FAULT_INJECTOR,
  type FaultInjector,
  ID_GENERATOR,
  type IdGenerator,
  INSTANCE_ID,
  METRICS,
  type Metrics,
  PLAYER_SESSION_POLICY,
  type PlayerSessionPolicy,
  type Source,
} from '../application/ports';
import { InvariantViolationError } from '../domain/domain-error';
import { FailureCode } from '../domain/failure-code';
import { LOGGER } from './logging/logging.module';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/**
 * Combinações de rótulos que alimentam alertas, criadas com 0 no boot: sem isso a série
 * nasce já com 1 na primeira ocorrência e `increase()` do Prometheus não a enxerga — o
 * alerta perderia justamente o primeiro evento (bug achado validando o Grafana).
 */
const DLQ_REASONS = [
  'malformed_json',
  'unknown_type',
  'invalid_schema',
  'invalid_payload',
  'inbox_payload_mismatch',
  'retries_exhausted',
  'bug',
  'permanent',
] as const;
const RETRY_COMPONENTS = ['consumer', 'outbox', 'pending_worker'] as const;
const DUPLICATE_TYPES: readonly DuplicateType[] = [
  'idempotent_replay',
  'payload_conflict',
  'key_mismatch',
  'inbox_duplicate',
];
const SOURCES: readonly Source[] = ['HTTP', 'SQS', 'WORKER', 'INTERNAL'];

/** Espera acima disso conta como conflito de lock (duas operações disputando a wallet). */
const LOCK_CONTENTION_THRESHOLD_SECONDS = 0.005;

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

/** Política padrão (D-19): o serviço não restringe jogos simultâneos. */
class AllowAllSessionPolicy implements PlayerSessionPolicy {
  async canBet(): Promise<boolean> {
    return true;
  }
}

export class InjectedFaultError extends Error {
  constructor(readonly point: string) {
    super(`falha injetada em ${point}`);
    this.name = 'InjectedFaultError';
  }
}

/**
 * Ativo somente com NODE_ENV=test; em qualquer outro ambiente é no-op.
 * `ponto` lança `InjectedFaultError`; `ponto:kill` mata o próprio processo com SIGKILL
 * exatamente ali (sem finally, sem shutdown, sem ack) — o "kill -9" dos testes de crash;
 * `ponto:bug` lança `InvariantViolationError` — simula um erro de programação;
 * `ponto:transient-once` lança `InfrastructureUnavailableError` só na primeira vez.
 */
type FaultMode = 'throw' | 'kill' | 'bug' | 'transient-once';
const FAULT_MODES: readonly string[] = ['kill', 'bug', 'transient-once'];

class EnvFaultInjector implements FaultInjector {
  private readonly points: Map<string, FaultMode>;

  constructor(env: Env) {
    const entries =
      env.NODE_ENV === 'test'
        ? env.FAULT_POINTS.split(',')
            .map((point) => point.trim())
            .filter(Boolean)
            .map((point): [string, FaultMode] => {
              const [name = point, mode] = point.split(':');
              return [name, mode && FAULT_MODES.includes(mode) ? (mode as FaultMode) : 'throw'];
            })
        : [];
    this.points = new Map(entries);
  }

  trigger(point: string): void {
    const mode = this.points.get(point);
    if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
    if (mode === 'bug') throw new InvariantViolationError(`bug injetado em ${point}`);
    if (mode === 'transient-once') {
      this.points.delete(point);
      throw new InfrastructureUnavailableError(`falha transitória injetada em ${point}`);
    }
    if (mode) throw new InjectedFaultError(point);
  }
}

/** Métricas de negócio (§12) em formato Prometheus, prefixo `wagering_`, por instância. */
@Injectable()
export class PrometheusMetrics implements Metrics {
  private readonly reconciliations: Counter<'result'>;
  private readonly divergences: Counter;
  private readonly transactions: Counter<'kind' | 'status' | 'source'>;
  private readonly duration: Histogram<'kind' | 'status' | 'source'>;
  private readonly duplicates: Counter<'source' | 'type'>;
  private readonly lockWaits: Histogram;
  private readonly lockConflicts: Counter;
  private readonly lockTimeouts: Counter;
  private readonly errors: Counter<'category' | 'failure_code'>;
  private readonly published: Counter;
  private readonly retries: Counter<'component'>;
  private readonly lag: Gauge;
  private readonly dlqMessages: Counter<'reason'>;
  private readonly depth: Gauge<'queue'>;
  private readonly queueWaits: Histogram;
  private readonly pending: Gauge;
  private readonly retention: Counter<'table'>;

  constructor(@Inject(METRICS_REGISTRY) registry: Registry) {
    const registers = [registry];
    this.reconciliations = new Counter({
      name: 'wagering_reconciliations_total',
      help: 'Reconciliações executadas, por resultado',
      labelNames: ['result'],
      registers,
    });
    this.divergences = new Counter({
      name: 'wagering_reconciliation_divergence_total',
      help: 'Wallets cujo saldo diverge do ledger (deve permanecer 0)',
      registers,
    });
    this.transactions = new Counter({
      name: 'wagering_transactions_total',
      help: 'Transações decididas, por tipo, status final e origem',
      labelNames: ['kind', 'status', 'source'],
      registers,
    });
    this.duration = new Histogram({
      name: 'wagering_processing_duration_seconds',
      help: 'Latência do processamento de uma transação (lock + decisão + commit)',
      labelNames: ['kind', 'status', 'source'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.duplicates = new Counter({
      name: 'wagering_duplicates_detected_total',
      help: 'Duplicatas detectadas: replay idempotente, conflito de payload, chave divergente',
      labelNames: ['source', 'type'],
      registers,
    });
    this.lockWaits = new Histogram({
      name: 'wagering_lock_wait_seconds',
      help: 'Espera pelo lock da wallet',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2.5, 5],
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'wagering_lock_conflicts_total',
      help: 'Operações que esperaram outra operação liberar o lock da mesma wallet',
      registers,
    });
    this.lockTimeouts = new Counter({
      name: 'wagering_lock_timeouts_total',
      help: 'Esperas pelo lock que estouraram o lock_timeout (hot wallet)',
      registers,
    });
    this.errors = new Counter({
      name: 'wagering_errors_total',
      help: 'Erros por categoria e failureCode',
      labelNames: ['category', 'failure_code'],
      registers,
    });
    this.published = new Counter({
      name: 'wagering_outbox_published_total',
      help: 'Eventos da outbox publicados no SQS por esta instância',
      registers,
    });
    this.retries = new Counter({
      name: 'wagering_retries_total',
      help: 'Novas tentativas agendadas, por componente',
      labelNames: ['component'],
      registers,
    });
    this.lag = new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo da outbox',
      registers,
    });
    this.dlqMessages = new Counter({
      name: 'wagering_dlq_messages_total',
      help: 'Mensagens enviadas à DLQ pelo consumidor, por motivo',
      labelNames: ['reason'],
      registers,
    });
    this.depth = new Gauge({
      name: 'wagering_queue_depth',
      help: 'Mensagens na fila (visíveis + em processamento), lidas do SQS pelo scheduler',
      labelNames: ['queue'],
      registers,
    });
    this.queueWaits = new Histogram({
      name: 'wagering_queue_wait_seconds',
      help: 'Tempo entre o envio da mensagem e o início do consumo',
      buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300],
      registers,
    });
    this.pending = new Gauge({
      name: 'wagering_pending_references',
      help: 'Transações aguardando a referência (PENDING_REFERENCE)',
      registers,
    });
    this.retention = new Counter({
      name: 'wagering_retention_deleted_total',
      help: 'Linhas apagadas pela retenção (outbox publicada, inbox processada)',
      labelNames: ['table'],
      registers,
    });
    this.initializeAlertSeries();
  }

  outboxPublished(count: number): void {
    this.published.inc(count);
  }

  retry(component: 'outbox' | 'consumer' | 'pending_worker'): void {
    this.retries.inc({ component });
  }

  outboxLag(seconds: number): void {
    this.lag.set(seconds);
  }

  dlq(reason: string): void {
    this.dlqMessages.inc({ reason });
  }

  queueDepth(queue: string, messages: number): void {
    this.depth.set({ queue }, messages);
  }

  queueWait(seconds: number): void {
    this.queueWaits.observe(seconds);
  }

  pendingReferences(count: number): void {
    this.pending.set(count);
  }

  retentionDeleted(table: 'outbox_messages' | 'inbox_messages', count: number): void {
    this.retention.inc({ table }, count);
  }

  private initializeAlertSeries(): void {
    for (const reason of DLQ_REASONS) this.dlqMessages.labels({ reason }).inc(0);
    for (const component of RETRY_COMPONENTS) this.retries.labels({ component }).inc(0);
    for (const source of SOURCES) {
      for (const type of DUPLICATE_TYPES) this.duplicates.labels({ source, type }).inc(0);
    }
    for (const failureCode of Object.values(FailureCode)) {
      this.errors.labels({ category: 'business', failure_code: failureCode }).inc(0);
    }
    for (const table of ['outbox_messages', 'inbox_messages'] as const) {
      this.retention.labels({ table }).inc(0);
    }
  }

  reconciliation(result: 'consistent' | 'inconsistent'): void {
    this.reconciliations.inc({ result });
    if (result === 'inconsistent') this.divergences.inc();
  }

  transaction(labels: { kind: string; status: string; source: Source }, seconds: number): void {
    this.transactions.inc(labels);
    this.duration.observe(labels, seconds);
  }

  duplicate(labels: { source: Source; type: DuplicateType }): void {
    this.duplicates.inc(labels);
  }

  lockWait(seconds: number): void {
    this.lockWaits.observe(seconds);
    if (seconds >= LOCK_CONTENTION_THRESHOLD_SECONDS) this.lockConflicts.inc();
  }

  lockTimeout(): void {
    this.lockTimeouts.inc();
  }

  error(labels: { category: string; failureCode: string }): void {
    this.errors.inc({ category: labels.category, failure_code: labels.failureCode });
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

/** Serviços técnicos transversais: relógio, ids, logger, métricas e pontos de extensão. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: APP_LOGGER, inject: [LOGGER], useFactory: (logger: Logger): AppLogger => logger },
    { provide: INSTANCE_ID, inject: [APP_CONFIG], useFactory: (env: Env) => env.INSTANCE_ID },
    { provide: PLAYER_SESSION_POLICY, useClass: AllowAllSessionPolicy },
    {
      provide: FAULT_INJECTOR,
      inject: [APP_CONFIG],
      useFactory: (env: Env) => new EnvFaultInjector(env),
    },
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
  exports: [
    CLOCK,
    ID_GENERATOR,
    APP_LOGGER,
    INSTANCE_ID,
    PLAYER_SESSION_POLICY,
    FAULT_INJECTOR,
    METRICS,
    METRICS_REGISTRY,
  ],
})
export class PlatformModule {}
