# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com correção sob duplicidade, entrega fora de ordem e concorrência entre instâncias.

> 🚧 **Status:** Iteração 0 concluída (fundação: NestJS em Bun, Compose com 3 réplicas, MikroORM, Testcontainers). Próxima: Iteração 1 — domínio. Ver [plano de iterações](./docs/02-escopo-agile.md#6-plano-de-iterações).

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

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start:dev` | app com watch |
| `bun run test:unit` | testes de unidade (sem infraestrutura) |
| `bun run test:integration` | integração com Postgres e LocalStack **reais** via Testcontainers (precisa de Docker) |
| `bun run lint` / `bun run format` | Biome (lint + formatação) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun run migration:up` / `migration:down` / `migration:create` | migrations (MikroORM) |
| `aws --profile localstack sqs list-queues` | inspecionar filas |

Chegam nas próximas iterações: `test:concurrency` (I3/I6), `test:load` (I6) e o perfil `observability` com Grafana e Mailpit (I6).

## Configuração

Toda a configuração vem de variáveis de ambiente, validadas no boot (`src/config/env.ts`; falha rápido com a lista de erros). Principais: `DATABASE_URL`, `DB_POOL_MAX`, `AWS_ENDPOINT_URL`, `APP_ROLE` (`api,consumer,outbox,scheduler,notifier` ou `all`), `LOG_LEVEL`, `PORT`.

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
| [docs/CHALLENGE.md](./docs/CHALLENGE.md) | enunciado original |
