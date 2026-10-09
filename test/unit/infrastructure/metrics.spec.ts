import { describe, expect, it } from 'bun:test';
import { Registry } from 'prom-client';
import { PrometheusMetrics } from '../../../src/shared/infrastructure/platform.module';

/**
 * Bug encontrado validando o Grafana com o Playwright: séries com rótulo só nasciam no
 * primeiro incremento, já com valor 1, e `increase()` do Prometheus não enxerga 0 → 1 —
 * o alerta "DLQ recebendo" não disparava na PRIMEIRA mensagem. As combinações que alimentam
 * alertas precisam existir com valor 0 desde o boot.
 */
describe('métricas inicializadas com zero', () => {
  async function scrape() {
    const registry = new Registry();
    new PrometheusMetrics(registry);
    return registry.metrics();
  }

  it.each([
    'wagering_dlq_messages_total{reason="malformed_json"} 0',
    'wagering_dlq_messages_total{reason="unknown_type"} 0',
    'wagering_dlq_messages_total{reason="invalid_schema"} 0',
    'wagering_dlq_messages_total{reason="invalid_payload"} 0',
    'wagering_dlq_messages_total{reason="inbox_payload_mismatch"} 0',
    'wagering_dlq_messages_total{reason="retries_exhausted"} 0',
    'wagering_dlq_messages_total{reason="bug"} 0',
    'wagering_dlq_messages_total{reason="permanent"} 0',
    'wagering_errors_total{category="business",failure_code="REVERSAL_INSUFFICIENT_FUNDS"} 0',
    'wagering_errors_total{category="business",failure_code="INSUFFICIENT_FUNDS"} 0',
    'wagering_retries_total{component="consumer"} 0',
    'wagering_retries_total{component="outbox"} 0',
    'wagering_retries_total{component="pending_worker"} 0',
    'wagering_duplicates_detected_total{source="HTTP",type="payload_conflict"} 0',
    'wagering_duplicates_detected_total{source="SQS",type="inbox_duplicate"} 0',
    'wagering_retention_deleted_total{table="inbox_messages"} 0',
  ])('%s', async (series) => {
    expect(await scrape()).toContain(series);
  });

  it('a primeira ocorrência vira um incremento visível (0 → 1)', async () => {
    const registry = new Registry();
    const metrics = new PrometheusMetrics(registry);
    metrics.dlq('malformed_json');
    expect(await registry.metrics()).toContain(
      'wagering_dlq_messages_total{reason="malformed_json"} 1',
    );
  });
});

describe('profundidade das filas (revisão técnica, divergência 2)', () => {
  it('expõe wagering_queue_depth por fila — a DLQ alimentada pelo redrive do SQS também', async () => {
    const registry = new Registry();
    const metrics = new PrometheusMetrics(registry);
    metrics.queueDepth('wager_dlq', 3);
    metrics.queueDepth('wager', 0);
    const text = await registry.metrics();
    expect(text).toContain('wagering_queue_depth{queue="wager_dlq"} 3');
    expect(text).toContain('wagering_queue_depth{queue="wager"} 0');
  });
});
