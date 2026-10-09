# ARCHITECTURE

> Registro das decisões técnicas, trade-offs e limitações do **Distributed Wagering Processor**.
> Detalhamento em [`docs/`](./docs). Este documento é vivo: cada decisão nova entra como ADR.

## Visão geral

Monólito modular NestJS sobre Bun, com arquitetura hexagonal. A mesma imagem roda em N réplicas e assume papéis (`api`, `consumer`, `outbox`, `scheduler`). PostgreSQL é a **fonte da verdade** de todas as invariantes. O SQS serve como transporte *at-least-once*, e a ordenação FIFO é usada apenas como otimização.

Diagramas: [docs/05-diagramas.md](./docs/05-diagramas.md).

## Registro de decisões (ADR)

| # | Decisão | Alternativas consideradas | Trade-off aceito |
|---|---|---|---|
| ADR-01 | **MikroORM** com entidades ORM separadas do domínio + mappers | TypeORM; `EntitySchema` direto nas classes de domínio | mais código de mapeamento, em troca de um domínio sem decorators e com `rehydrate` como ponto único |
| ADR-02 | `Money` com **`bigint` em centavos** (escala fixa 2); `NUMERIC(20,2)` no banco; string decimal na borda | `decimal.js`, `big.js` | não suporta moedas com escala ≠ 2 (fora do escopo) |
| ADR-03 | **Lock pessimista por wallet** (`SELECT … FOR UPDATE`) + `CHECK (balance >= 0)` + `version` | optimistic + retry; `UPDATE` condicional; advisory lock | throughput de uma única hot wallet fica serializado (correto por definição) |
| ADR-04 | Isolamento `READ COMMITTED`, `lock_timeout 5s` → erro transitório | `SERIALIZABLE` | depende da disciplina de lock explícito |
| ADR-05 | Idempotência por `UNIQUE (idempotency_key)` **e** `UNIQUE (provider_id, external_transaction_id)`; `payloadHash` = SHA-256 do JSON canônico | cache/Redis | uma consulta extra por requisição |
| ADR-06 | Snapshot `balance_after` na transação para replay fiel | derivar do ledger | coluna redundante (necessária para `LOSS`/`REJECTED`) |
| ADR-07 | Rejeição de negócio é **persistida** (`REJECTED`) e idempotente | apenas responder erro | mais linhas no banco, em troca de auditoria completa |
| ADR-08 | Reversão única por referência, **qualquer tipo** (índice único parcial). `REFUND` e `ROLLBACK` compartilham **um único fluxo** (`ReverseTransaction`); a primeira vence e a segunda é rejeitada apontando a vencedora | leitura literal "mesmo tipo"; segurar o `REFUND` até "confirmar que não haverá rollback" | mais restritivo que o enunciado; evita crédito duplo. A espera foi descartada porque não há sinal de fim de rodada, ambas creditam o mesmo valor sobre a `BET` e todo reembolso seria atrasado |
| ADR-09 | Transactional Outbox com claim por **lease** + `FOR UPDATE SKIP LOCKED` | LISTEN/NOTIFY; CDC (Debezium) | publicação duplicada possível após expiração de lease (consumidor deduplica por `eventId`) |
| ADR-10 | Inbox `(consumer_name, message_id)` na mesma transação SQL | dedup do SQS FIFO | a janela de 5 min do SQS não basta e não é garantia |
| ADR-11 | Erros do consumidor: negócio → ack; transitório → backoff de visibilidade; permanente → DLQ imediata | só redrive | lógica de classificação explícita |
| ADR-12 | Worker de pendências: backoff `min(2^n s, 60 s)`, **10 tentativas / TTL 15 min** | TTL longo (horas) | provedor que demora mais que 15 min recebe `REFERENCE_NOT_FOUND` |
| ADR-13 | Eventos publicados em `wagering-events.fifo` | SNS fan-out | um destino só; fácil de trocar atrás da porta `MessagePublisher` |
| ADR-14 | Ledger imutável por **trigger** + sem `GRANT UPDATE/DELETE` | só convenção | migrations administrativas precisam de role própria |
| ADR-15 | Cursor do ledger = `wallet_version` (opaco em base64url) | `created_at, id` | estável e sem colisão por definição |
| ADR-16 | Autenticação **não implementada**: `AuthGuard` no-op + `ProviderIdentityPort`; desenho alvo com Keycloak (client credentials por provedor, `providerId` vindo do token e não do body) | Keycloak no compose | vale 0 pontos; o timebox vai para correção |
| ADR-17 | Validação com **zod**, o mesmo schema para HTTP e SQS | `class-validator` | sai do idioma mais comum do Nest |
| ADR-18 | IDs UUID v7 | UUID v4, ULID | — |
| ADR-19 | **Trilha de auditoria** `wager_transaction_audit`, append-only, 1 linha por decisão (inclusive replay e conflito), na mesma transação SQL; ligada ao lançamento (`ledger_entry_id`) e à transação relacionada | só logs estruturados; event sourcing completo | mais escrita por requisição (replays passam a fazer commit), em troca de responder por SQL "para onde foi o dinheiro e o que aconteceu" |
| ADR-20 | Observabilidade **100% gratuita e local**: OpenTelemetry + pino → `grafana/otel-lgtm` (Grafana, Prometheus, Loki, Tempo), `postgres-exporter`, Grafana com fonte PostgreSQL para dados exatos, Grafana Alerting → e-mail (Mailpit por padrão; SMTP real opcional via `.env`) | Datadog (pago após trial); dashboard próprio; Prometheus + Alertmanager avulsos | o repositório é público: roda sem conta nem chave e não versiona segredos |
| ADR-21 | **Relatório de incidente por e-mail**: o Grafana detecta e chama um webhook; o módulo `alerting` (papel `notifier`, banco read-only) enriquece com último cliente afetado (mascarado), impacto, atraso, gargalo (heurísticas determinísticas), filas e desfecho, e envia por SMTP (Mailpit local). Idempotente por `(fingerprint, startsAt)` na tabela `incidents`. Níveis crítico/médio/leve com políticas de reenvio; os leves vão num resumo horário | só template nativo do Grafana; notificador próprio que também detecta | mais um componente, isolado do caminho financeiro; fallback nativo do Grafana se ele cair |

Interpretações de requisitos ambíguos: [docs/01-analise-requisitos.md §6](./docs/01-analise-requisitos.md#6-ambiguidades-e-decisões-adotadas).

## Garantias e onde vivem

Ver a matriz completa em [docs/01 §5](./docs/01-analise-requisitos.md#5-matriz-regra--onde-é-imposta). Resumo: **o domínio valida primeiro, e o banco impede o que o domínio deixar passar.**

## Taxonomia de falhas e HTTP

Ver [docs/01 §7–8](./docs/01-analise-requisitos.md#7-taxonomia-de-failurecode).

## Observabilidade

Detalhes, catálogo de métricas, dashboards e alertas: [docs/06-observabilidade.md](./docs/06-observabilidade.md).

- **Logs:** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Redaction de payloads e valores.
- **Métricas** (`/metrics`, Prometheus):
  - `wager_transactions_total{status,kind}`, `duplicates_detected_total{source}`, `retries_total{component}`;
  - `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `processing_duration_seconds` (histograma);
  - `reconciliation_divergence_total`.
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres `SELECT 1` + SQS `GetQueueAttributes`).

## Limitações conhecidas

- Moeda com escala fixa de 2 casas. Reversão parcial está fora do escopo.
- Hot wallet tem throughput limitado pela serialização (por desenho).
- Entrega de eventos é *at-least-once*: consumidores precisam deduplicar por `eventId`.
- Reconciliação é sob demanda (não há job periódico).

_Seções a completar durante a implementação: resultados de carga, decisões revistas._
