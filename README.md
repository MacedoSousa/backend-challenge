# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com correção sob duplicidade, entrega fora de ordem e concorrência entre instâncias.

> ✅ **Status:** todo o obrigatório do enunciado implementado e testado (iterações 0 a 6): 212 testes de unidade, 96 de integração e 5 multi-processo com `SIGKILL`/`SIGTERM` reais. Conformidade item a item em [docs/07](./docs/07-conformidade.md). Conformidade com o enunciado em [docs/07](./docs/07-conformidade.md). Próxima: Iteração 2 — persistência das wallets. Ver [plano de iterações](./docs/02-escopo-agile.md#6-plano-de-iterações).

## Stack

Bun 1.4 · TypeScript 5.9 (strict) · NestJS 11 · MikroORM 6 · PostgreSQL 17 · AWS SQS (LocalStack 4) · Docker Compose · Biome · zod · pino

## Pré-requisitos

| Ferramenta | Versão testada | Observação |
|---|---|---|
| Docker + Compose | 29.8 / v5.5 | o usuário precisa estar no grupo `docker` |
| Bun | 1.4.2 | só para desenvolver/testar fora do container |
| AWS CLI (opcional) | 2.37 | perfil `localstack` para inspecionar filas |

## Como rodar

```bash
docker compose up -d --build --wait     # Postgres + LocalStack + setup + 3 réplicas + balanceador
curl localhost:3000/health/ready        # {"status":"up","checks":{"postgres":"up","sqs":"up"}}
docker compose down                     # (adicione -v para apagar o banco)
```

O que sobe:

| Serviço | Papel |
|---|---|
| `postgres` | banco (porta 5432, usuário/senha/db `wagering`) |
| `localstack` | SQS local (porta 4566) |
| `setup` | *one-shot* idempotente: aplica migrations e cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 tentativas) e `wagering-events.fifo` |
| `app` ×3 | réplicas da aplicação (`APP_REPLICAS` muda a quantidade) |
| `lb` | nginx em `localhost:3000`, round-robin entre as réplicas, failover em 1 s |

## Desenvolvimento local

```bash
bun install
docker compose up -d --wait postgres localstack
DATABASE_URL=postgres://wagering:wagering@localhost:5432/wagering \
AWS_ENDPOINT_URL=http://localhost:4566 bun src/setup.ts      # migrations + filas
DATABASE_URL=postgres://wagering:wagering@localhost:5432/wagering \
AWS_ENDPOINT_URL=http://localhost:4566 PORT=3100 bun run start:dev
```

## API disponível

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet (`{ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }`); saldo > 0 gera `OPENING` + `CREDIT` + eventos |
| `GET` | `/wallets/:walletId` | consulta a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=…&limit=50` | ledger paginado por cursor opaco (máx. 200) |
| `POST` | `/wallets/:walletId/reconciliation` | saldo armazenado × reconstruído pelo ledger |
| `POST` | `/wagering/transactions` | submete `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/wagering/transactions/:transactionId/audit` | linha do tempo imutável de decisões (auditoria) |
| `GET` | `/health/live`, `/health/ready` | liveness e readiness (Postgres + SQS) |
| `GET` | `/metrics` | métricas Prometheus **da réplica que respondeu** (colete cada instância) |

**Status HTTP de `POST /wagering/transactions`:** `201` processada · `200` replay · `202` aguardando referência · `400` payload inválido · `404` wallet inexistente · `409` conflito de idempotência · `422` rejeição de negócio (com `failureCode`) · `503` indisponibilidade temporária (com `Retry-After`).

Valores monetários são sempre strings com exatamente 2 casas (`"25.00"`). Erros seguem RFC 9457 (`application/problem+json`) com `failureCode` estável e `correlationId`.

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start:dev` | app com watch |
| `bun run test:unit` | testes de unidade (sem infraestrutura) |
| `bun run test:integration` | integração com Postgres e LocalStack **reais** via Testcontainers (precisa de Docker) |
| `bun run test:concurrency` | múltiplos processos reais da aplicação: 3 instâncias, `SIGKILL` após commit/publicação, reinício sob carga, `SIGTERM` |
| `bun run lint` / `bun run format` | Biome (lint + formatação) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun run migration:up` / `migration:down` / `migration:create` | migrations (MikroORM) |
| `aws --profile localstack sqs list-queues` | inspecionar filas |

Diferenciais planejados (I8): `test:load` (k6) e o perfil `observability` com Grafana e Mailpit.

## Configuração

Toda a configuração vem de variáveis de ambiente, validadas no boot (`src/config/env.ts`; falha rápido com a lista de erros). Principais: `DATABASE_URL`, `DB_POOL_MAX`, `AWS_ENDPOINT_URL`, `APP_ROLE` (`api,consumer,outbox,scheduler,notifier` ou `all`), `LOG_LEVEL`, `PORT`, `DB_LOCK_TIMEOUT_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_LEASE_MS`. Eventos de integração são publicados em `wagering-events.fifo` (grupo = wallet, deduplicação = `eventId`).

### Enviando pela fila

```bash
Q=$(aws --profile localstack sqs get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
aws --profile localstack sqs send-message --queue-url "$Q" \
  --message-group-id <walletId> --message-deduplication-id "$(uuidgen)" \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-123","idempotencyKey":"provider-a:transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Mensagens inválidas vão para `wager-transactions-dlq.fifo` com o atributo `reason` (`malformed_json`, `unknown_type`, `invalid_schema`, `invalid_payload:<código>`, `inbox_payload_mismatch`); falhas transitórias voltam com backoff e, após `SQS_MAX_RECEIVE_COUNT` recebimentos, o redrive as leva à DLQ.

> Alertas chegarão por e-mail no Mailpit sem configurar nada. Para usar um SMTP real, copie `.env.example` para `.env` e preencha. O `.env` nunca é versionado.

## Documentação

| Documento | Conteúdo |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | decisões (ADR), escalabilidade, trade-offs, limitações |
| [docs/01-analise-requisitos.md](./docs/01-analise-requisitos.md) | requisitos, invariantes, ambiguidades, failure codes, HTTP |
| [docs/02-escopo-agile.md](./docs/02-escopo-agile.md) | épicos, histórias, DoR/DoD, iterações, riscos |
| [docs/03-padroes-arquitetura.md](./docs/03-padroes-arquitetura.md) | hexagonal, padrões NestJS, schema, concorrência, mensageria |
| [docs/04-estrategia-testes.md](./docs/04-estrategia-testes.md) | TDD, cenários unitários, integração, concorrência e carga |
| [docs/05-diagramas.md](./docs/05-diagramas.md) | contexto, deploy, componentes, ER, estados, sequências, reversão e auditoria |
| [docs/06-observabilidade.md](./docs/06-observabilidade.md) | métricas, traces, logs, dashboards, alertas e notificações (stack gratuito) |
| [docs/07-conformidade.md](./docs/07-conformidade.md) | matriz item do enunciado (§1–§14) → onde é atendido → teste → situação |
| [docs/CHALLENGE.md](./docs/CHALLENGE.md) | enunciado original |
