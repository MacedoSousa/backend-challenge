# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, via **HTTP** e **SQS**, e permanece correto quando mensagens chegam **duplicadas**, **fora de ordem** ou **simultaneamente** — com várias instâncias rodando ao mesmo tempo.

> ✅ Todo o obrigatório do enunciado (§1–§13) implementado e testado: **214 testes de unidade, 97 de integração e 5 multi-processo**, sempre contra PostgreSQL e LocalStack **reais**. Conformidade item a item: [docs/07-conformidade.md](./docs/07-conformidade.md).

**Stack:** Bun 1.4 · TypeScript 5.9 (strict) · NestJS 11 · MikroORM 6 · PostgreSQL 17 · AWS SQS (LocalStack 4) · Docker Compose · zod · pino · prom-client · Biome

---

## Rodando em 3 comandos

Pré-requisito: Docker com Compose (o usuário precisa poder rodar `docker` sem `sudo`).

```bash
docker compose up -d --build --wait     # Postgres, LocalStack, setup, 3 réplicas e balanceador
curl localhost:3000/health/ready        # {"status":"up","checks":{"postgres":"up","sqs":"up"}}
docker compose down -v                  # derruba tudo e apaga o banco
```

| Serviço | Papel |
|---|---|
| `postgres` | banco (`localhost:5432`, usuário/senha/db `wagering`) |
| `localstack` | SQS local (`localhost:4566`) |
| `setup` | *one-shot* idempotente: aplica as migrations e cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wagering-events.fifo` |
| `app` ×3 | réplicas com todos os papéis (`api`, `consumer`, `outbox`, `scheduler`); `APP_REPLICAS` muda a quantidade |
| `lb` | nginx em `localhost:3000`, round-robin entre as réplicas, failover em 1 s |

## Roteiro rápido (copie e cole)

Requer `curl` e `jq`.

```bash
API=localhost:3000
PLAYER=$(cat /proc/sys/kernel/random/uuid)

# 1. wallet com 100.00 (gera OPENING + CREDIT + eventos na outbox, na mesma transação)
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | jq -r .id)

bet() { curl -s -w '  HTTP %{http_code}\n' -X POST $API/wagering/transactions \
  -H 'content-type: application/json' -H "idempotency-key: provider-a:$1" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"$2\",\"currency\":\"BRL\"}}"; }

# 2. o cenário obrigatório: duas apostas de 80.00 ao mesmo tempo
bet bet-1 80.00 & bet bet-2 80.00 & wait      # uma 201 PROCESSED, outra 422 INSUFFICIENT_FUNDS

# 3. replay: mesma operação → mesma resposta, idempotentReplay: true
bet bet-1 80.00

# 4. mesma chave com outro valor → 409, nada muda
bet bet-1 10.00

# 5. saldo, ledger, reconciliação e a linha do tempo de auditoria
curl -s $API/wallets/$WALLET | jq '{balance, version}'
curl -s "$API/wallets/$WALLET/ledger" | jq '.items[] | {walletVersion, direction, money, balanceAfter}'
curl -s -X POST $API/wallets/$WALLET/reconciliation | jq '{consistent, difference}'
TX=$(curl -s $API/providers/provider-a/wagering/transactions/bet-1 | jq -r .id)
curl -s $API/wagering/transactions/$TX/audit | jq '.items[] | {action, source, instanceId}'
```

### Pela fila SQS

Com a [AWS CLI](https://aws.amazon.com/cli/) (o LocalStack aceita as credenciais `test`/`test`):

```bash
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
SQS="aws --endpoint-url http://localhost:4566 sqs"
Q=$($SQS get-queue-url --queue-name wager-transactions.fifo --query QueueUrl --output text)
$SQS send-message --queue-url "$Q" \
  --message-group-id "$WALLET" --message-deduplication-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-29T15:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"win-1\",\"idempotencyKey\":\"provider-a:win-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",\"money\":{\"amount\":\"50.00\",\"currency\":\"BRL\"}}}"
```

Mensagens inválidas vão para `wager-transactions-dlq.fifo` com o atributo `reason` (`malformed_json`, `unknown_type`, `invalid_schema`, `invalid_payload:<código>`, `inbox_payload_mismatch`).

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet `{ playerId, initialBalance: { amount, currency } }` |
| `GET` | `/wallets/:walletId` | consulta a wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=…&limit=50` | ledger em ordem, cursor opaco e estável (máx. 200) |
| `POST` | `/wallets/:walletId/reconciliation` | saldo armazenado × reconstruído pelo ledger (divergência é sinalizada, nunca corrigida) |
| `POST` | `/wagering/transactions` | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` — header `Idempotency-Key` obrigatório |
| `GET` | `/wagering/transactions/:transactionId` | consulta por id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/wagering/transactions/:transactionId/audit` | linha do tempo imutável de decisões |
| `GET` | `/health/live`, `/health/ready` | liveness; readiness (Postgres + SQS) — sem autenticação |
| `GET` | `/metrics` | métricas Prometheus **da réplica que respondeu** (colete cada instância) |

**Status de `POST /wagering/transactions`:** `201` processada · `200` replay · `202` aguardando a referência · `400` payload inválido · `404` wallet inexistente · `409` conflito de idempotência · `422` rejeição de negócio · `503` indisponibilidade temporária (com `Retry-After`).

Valores monetários são **sempre** strings com exatamente 2 casas (`"25.00"`). Todo erro é `application/problem+json` (RFC 9457) com `failureCode` estável e `correlationId` — a taxonomia completa, com a ação recomendada ao provedor, está em [docs/01 §7](./docs/01-analise-requisitos.md#7-taxonomia-de-failurecode).

## Testes

```bash
bun install
bun run test:unit           # 214 — domínio puro, sem infraestrutura (~1 s)
bun run test:integration    # 97 — Postgres e LocalStack reais via Testcontainers (~1,5 min)
bun run test:concurrency    # 5 — processos reais com SIGKILL/SIGTERM (~35 s)
bun run lint && bun run typecheck
```

| Suíte | O que prova |
|---|---|
| unidade | `Money` exato (rejeita `number`, notação científica, > 2 casas), invariantes da `Wallet`, máquina de estados, regras de BET/WIN/LOSS/REFUND/ROLLBACK, políticas de referência e de retry, eventos; **teste de arquitetura** impede o domínio de importar framework/ORM/SDK ou converter valores para `number` |
| integração | cada constraint do schema recusando a violação; atomicidade com falha injetada antes do commit; idempotência, replay e conflitos; inbox, redelivery, retry e DLQ; publishers concorrentes; referências fora de ordem; CT-01 (50× a mesma aposta → 1 débito), CT-02 (2× 80.00 sobre 100.00, repetido 10×), CT-10 (REFUND × ROLLBACK simultâneos) |
| multi-processo | CT-04 (3 instâncias numa hot wallet → exatamente 100 aprovadas de 200), CT-05 (`SIGKILL` após o commit, antes do ack), CT-06 (`SIGKILL` no publisher), CT-08 (todas as instâncias mortas sob carga e reiniciadas), `SIGTERM` gracioso |

Todo teste que toca saldo termina verificando a invariante do §13: `wallet.balance == saldo reconstruído pelo ledger`, com a cadeia `balance_before → balance_after` contínua e sem buracos de versão.

## Guia para avaliação (§14)

| Área | Onde olhar |
|---|---|
| Correção financeira | [`money.ts`](./src/shared/domain/money.ts), [`wallet.ts`](./src/modules/wallet/domain/wallet.ts), [migration do schema](./src/database/migrations/Migration20261009100000_wallet_ledger_schema.ts) (CHECKs, cadeia do ledger, consistência no commit), reconciliação |
| Concorrência | `lockById` em [`mikro-orm-unit-of-work.ts`](./src/shared/infrastructure/database/mikro-orm-unit-of-work.ts), ADR-03, [`concurrency.spec.ts`](./test/integration/concurrency.spec.ts), [`multi-process.spec.ts`](./test/concurrency/multi-process.spec.ts) |
| Idempotência | [`process-wager-transaction.use-case.ts`](./src/modules/wagering/application/process-wager-transaction.use-case.ts), [`payload-hash.ts`](./src/modules/wagering/domain/payload-hash.ts), ADR-05/06/30 |
| Mensageria e falhas | [consumidor](./src/modules/wagering/presentation/sqs/wager-transaction.consumer.ts), [outbox](./src/modules/messaging/application/publish-outbox.use-case.ts), [worker de pendências](./src/modules/wagering/application/resolve-pending-references.use-case.ts), [todas as políticas de retry](./docs/03-padroes-arquitetura.md#91-todas-as-políticas-de-retry-do-sistema) |
| Modelagem e arquitetura | `src/**/domain` (TS puro), portas em [`ports.ts`](./src/shared/application/ports.ts), [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Testes | `test/unit`, `test/integration`, `test/concurrency`, [docs/04](./docs/04-estrategia-testes.md) |
| Observabilidade | `/metrics`, logs JSON com `correlationId`/`messageId`/`transactionId`/`walletId`/`providerId`, health, [docs/06](./docs/06-observabilidade.md) |
| Documentação | este README, [ARCHITECTURE.md](./ARCHITECTURE.md), [docs/](./docs) |

## Estrutura

```
src/
├── shared/
│   ├── domain/            Money, erros de domínio, failureCode
│   ├── application/       portas (UnitOfWork, repositórios, métricas, relógio…)
│   ├── infrastructure/    MikroORM (Unit of Work, mappers), SQS, logs, métricas, PollingLoop
│   └── presentation/      problem details (RFC 9457), validação zod
├── modules/
│   ├── wallet/            Wallet, ledger, API de wallets, reconciliação
│   ├── wagering/          WagerTransaction, políticas, processamento, consumidor SQS, worker
│   ├── messaging/         eventos de integração, inbox/outbox, publisher
│   ├── health/  auth/     health checks; AuthGuard no-op (ADR-16)
├── database/migrations/   schema versionado e reversível
test/
├── unit/  integration/  concurrency/
docs/                      análise, escopo, padrões, testes, diagramas, observabilidade, conformidade
```

## Configuração

Variáveis de ambiente validadas no boot (`src/config/env.ts`; o erro lista todos os problemas).

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | Postgres |
| `DB_POOL_MAX` | `10` | conexões por instância — com 3 réplicas, 30 das 100 do Postgres padrão |
| `DB_LOCK_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | `5000` / `10000` | aplicados com `SET LOCAL` em cada transação |
| `APP_ROLE` | `all` | `api`, `consumer`, `outbox`, `scheduler` (lista separada por vírgula) |
| `AWS_ENDPOINT_URL` | — | LocalStack (`http://localhost:4566`) |
| `SQS_MAX_RECEIVE_COUNT` | `5` | recebimentos antes do redrive para a DLQ |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` / `SQS_WAIT_TIME_SECONDS` | `60` / `10` | consumidor |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_LEASE_MS` | `50` / `500` / `30000` | publisher |
| `REFERENCE_RETRY_*` | 1 s, teto 60 s, 10 tentativas, TTL 15 min | §7.1 (ADR-12) |
| `LOG_LEVEL` | `info` | pino |

Desenvolvimento fora do container:

```bash
bun install
docker compose up -d --wait postgres localstack
export DATABASE_URL=postgres://wagering:wagering@localhost:5432/wagering AWS_ENDPOINT_URL=http://localhost:4566
bun src/setup.ts                 # migrations + filas
PORT=3100 bun run start:dev
```

## Decisões e limitações

As decisões (30 ADRs), as adaptações das assinaturas sugeridas, a escalabilidade e as **limitações conhecidas** estão no [ARCHITECTURE.md](./ARCHITECTURE.md). Destaques:

- **Autenticação não implementada** (vale 0 pontos): `AuthGuard` no-op + desenho com Keycloak documentado (ADR-16).
- **Reversão única por qualquer tipo** — mais restrito que a leitura literal da regra 4, para nunca creditar duas vezes (ADR-08).
- **Valores de entrada estritamente canônicos** (`"25.00"`, nunca `"25"`) — leitura do §6.1 (D-06).

## Documentação

| Documento | Conteúdo |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | decisões (ADR), adaptações, escalabilidade, trade-offs, limitações |
| [docs/01-analise-requisitos.md](./docs/01-analise-requisitos.md) | requisitos, invariantes, ambiguidades e decisões, `failureCode`, mapeamento HTTP |
| [docs/02-escopo-agile.md](./docs/02-escopo-agile.md) | épicos, histórias, DoR/DoD, iterações, riscos |
| [docs/03-padroes-arquitetura.md](./docs/03-padroes-arquitetura.md) | hexagonal, padrões NestJS, schema, concorrência, mensageria, retries |
| [docs/04-estrategia-testes.md](./docs/04-estrategia-testes.md) | TDD, cenários de unidade, integração, concorrência e carga |
| [docs/05-diagramas.md](./docs/05-diagramas.md) | contexto, deploy, componentes, ER, estados, sequências |
| [docs/06-observabilidade.md](./docs/06-observabilidade.md) | métricas e logs; dashboards e alertas planejados como diferencial |
| [docs/07-conformidade.md](./docs/07-conformidade.md) | matriz enunciado (§1–§14) → onde → teste → situação |
| [docs/CHALLENGE.md](./docs/CHALLENGE.md) | enunciado original |
