# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com correção sob duplicidade, entrega fora de ordem e concorrência entre instâncias.

> 🚧 **Status:** fase de planejamento concluída; implementação em andamento (ver [plano de iterações](./docs/02-escopo-agile.md#6-plano-de-iterações)).

## Stack

Bun 1.x · TypeScript (strict) · NestJS · PostgreSQL 17 · MikroORM · AWS SQS (LocalStack) · Docker Compose

## Pré-requisitos

| Ferramenta | Versão testada |
|---|---|
| Bun | 1.4.2 |
| Docker + Compose | 29.8 / v5.5 |
| AWS CLI (opcional, inspeção das filas) | 2.37 — perfil `localstack` |

## Como rodar

```bash
bun install
docker compose up -d                # Postgres + LocalStack (filas) + 3 réplicas da app
bun run migration:up
curl localhost:3000/health/ready
```

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start:dev` | app local com watch |
| `bun run test:unit` | testes de unidade |
| `bun run test:integration` | integração (Postgres + LocalStack reais via Testcontainers) |
| `bun run test:concurrency` | concorrência, crash e múltiplas instâncias |
| `bun run test:load` | teste de carga (k6) |
| `bun run lint` / `bun run typecheck` | qualidade |
| `aws --profile localstack sqs list-queues` | inspecionar filas |
| `docker compose --profile observability up -d` | Grafana (dashboards, logs, traces, alertas) em `localhost:3001` e Mailpit (e-mails de alerta) em `localhost:8025` |

> Alertas chegam por e-mail no Mailpit sem configurar nada. Para usar um SMTP real, copie `.env.example` para `.env` e preencha. O `.env` nunca é versionado.

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
