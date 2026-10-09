# 03 — Padrões de Arquitetura e Código (NestJS + TypeScript)

## 1. Estilo arquitetural

**Hexagonal (Ports & Adapters) + DDD tático**, em um **monólito modular** com um único deploy e múltiplos papéis de execução.

- **Domínio** — classes puras de TS. Não importa NestJS, MikroORM nem SDK da AWS. É onde vivem as invariantes.
- **Aplicação** — use cases (um por comando ou consulta) que orquestram domínio e portas, e definem a fronteira transacional.
- **Infraestrutura** — adapters: repositórios MikroORM, cliente SQS, relógio, gerador de IDs, métricas.
- **Apresentação** — controllers HTTP e consumidor SQS. São *driving adapters*, finos, que só traduzem para o use case.

**Regra de dependência:** `presentation → application → domain` e `infrastructure → application/domain`. O domínio não depende de ninguém. Essa regra é verificada no lint (`eslint-plugin-boundaries` ou `dependency-cruiser`).

## 2. Estrutura de pastas

Estrutura real (o desenho inicial previa um módulo `alerting`, adiado para a I8):

```
src/
├── main.ts                      # bootstrap; configureApp() comum a produção e testes
├── setup.ts                     # migrations + filas (serviço `setup` do Compose)
├── app.module.ts
├── config/                      # env validado com zod (falha rápida)
├── database/
│   ├── migrations/              # SQL versionado e reversível (4 migrations)
│   └── mikro-orm.config.ts
├── shared/
│   ├── domain/                  # Money, DomainError, InvariantViolationError, FailureCode
│   ├── application/             # portas (UnitOfWork, repositórios, Clock, Metrics…) e erros
│   ├── infrastructure/
│   │   ├── database/            # EntitySchemas, mappers, MikroOrmUnitOfWork (lock, timeouts)
│   │   ├── logging/             # pino + AsyncLocalStorage (correlationId)
│   │   ├── sqs/                 # cliente e topologia de filas
│   │   ├── platform.module.ts   # relógio, ids, métricas Prometheus, FaultInjector
│   │   └── polling-loop.ts      # laço dos workers
│   └── presentation/http/       # ProblemDetailsFilter, ZodValidationPipe
└── modules/
    ├── wallet/                  # domain (Wallet, ledger) · application · presentation/http
    ├── wagering/
    │   ├── domain/              # WagerTransaction, ReferencePolicy, ReferenceRetryPolicy, payloadHash
    │   ├── application/         # WagerProcessor, ProcessWagerTransaction, ResolvePendingReferences, consultas
    │   ├── infrastructure/      # claim de pendências + worker
    │   └── presentation/        # contrato zod comum, http/, sqs/ (consumidor)
    ├── messaging/               # domain (eventos, inbox, outbox) · application (PublishOutbox) · infrastructure
    ├── health/
    └── auth/                    # AuthGuard no-op + ProviderIdentityPort
test/
├── unit/                        # domínio, aplicação com dublês, arquitetura, logs
├── integration/                 # Testcontainers: Postgres + LocalStack reais
└── concurrency/                 # processos reais (Bun.spawn), SIGKILL/SIGTERM
```

## 3. Padrões NestJS adotados

| Padrão | Uso | Motivo |
|---|---|---|
| **Módulos por bounded context** | `WalletModule`, `WageringModule`, `MessagingModule` | coesão e fronteiras explícitas |
| **Injeção por token de porta** | `@Inject(WALLET_REPOSITORY)` com `Symbol` | use case depende da porta, não do MikroORM |
| **Um use case por classe** | `ProcessWagerTransactionUseCase.execute(cmd)` | SRP; HTTP e SQS reutilizam o mesmo use case |
| **Validação na borda com zod** | `ZodValidationPipe` e o mesmo schema no consumidor SQS | um contrato só para HTTP e fila; sem `class-validator` no domínio |
| **Exception filter global** | `DomainExceptionFilter` mapeia `DomainError → HTTP` | mapeamento consistente ([01 §8](./01-analise-requisitos.md#8-mapeamento-http)) |
| **Interceptor de correlação** | lê ou gera `X-Correlation-Id` e propaga via `AsyncLocalStorage` | logs correlacionados entre HTTP, use case e outbox |
| **Lifecycle hooks** | `OnApplicationBootstrap` inicia os workers e `BeforeApplicationShutdown` os drena | shutdown gracioso |
| **Config tipada** | `ConfigModule` com schema zod e falha rápida | erro de env no boot, não em runtime |
| **Papéis de execução** | `APP_ROLE=api,consumer,outbox,scheduler,notifier` (padrão: todos) | a mesma imagem escala por papel |
| **Guard de autenticação** | `AuthGuard` global no-op, `@Public()` no health | ponto de extensão explícito |

## 4. Padrões de domínio

- **Construtor privado + factories:** `create/open` validam regras; `rehydrate` só reconstrói o estado persistido, sem revalidar.
- **Value Object:** `Money` é imutável, guarda `bigint` em centavos e tem escala fixa de 2.
  - Optei por `bigint` em vez de lib decimal: com escala fixa, a aritmética é exata, sem dependência e sem arredondamento possível.
  - Na borda, o valor é sempre uma string decimal (`"25.00"`).
- **Aggregate Root:** `Wallet` é a única porta para alterar saldo. `debit/credit` retornam o `WalletLedgerEntry` já calculado, então saldo e ledger nascem juntos.
- **Máquina de estados explícita:** em `WagerTransaction`, transição inválida lança `InvalidTransactionStateError` (erro de programação).
- **Policy (Strategy):** `ReferencePolicy` valida referências e é testável isoladamente.
- **Fluxo único de reversão:** `REFUND` e `ROLLBACK` chegam por portas diferentes (o `kind` do payload), mas executam o **mesmo** serviço de domínio `ReverseTransaction`. A diferença entre eles é só uma tabela de configuração:

  | kind | referências aceitas | direção do lançamento |
  |---|---|---|
  | `REFUND` | `BET` | inverso da referência (`CREDIT`) |
  | `ROLLBACK` | `BET`, `WIN`, `REFUND` | inverso da referência |

  O mesmo lock, a mesma validação (provider, player, wallet, moeda, rodada, valor), a mesma regra de reversão única e a mesma auditoria. Um bug corrigido no fluxo vale para os dois.
- **Políticas como portas (extensão sem mexer no núcleo):** `PlayerSessionPolicy.assertCanBet(playerId, gameId, roundId)` é chamada antes de cada `BET`. A implementação padrão permite tudo (D-19); uma futura implementação (ex.: consultando a plataforma) rejeitaria com `CONCURRENT_GAME_NOT_ALLOWED`, sem alterar o use case.
- **Auditoria como efeito do use case:** cada decisão gera um `AuditRecord`, que é gravado pela porta `AuditTrail` na mesma Unit of Work. Não é log de aplicação: é dado de negócio, consultável e imutável.
- **Erros tipados:** `DomainError` traz `failureCode` e categoria (`validation | conflict | business | transient | permanent`). Exceções não são usadas como fluxo de negócio esperado: a rejeição é um **resultado** persistido (`REJECTED`).
- **Domínio sem relógio nem aleatoriedade:** `Clock` e `IdGenerator` são injetados, o que deixa os testes determinísticos.

## 5. Persistência (MikroORM)

| Decisão | Escolha | Justificativa |
|---|---|---|
| ORM | **MikroORM** (preferencial) | `em.transactional()`, `LockMode.PESSIMISTIC_WRITE`, Unit of Work explícito |
| Mapeamento | Entidades ORM separadas do domínio + mappers | o domínio fica sem decorators; o `rehydrate` é o ponto único de reconstrução |
| `Money` no banco | `NUMERIC(20,2)` + `CHAR(3)` currency, via custom type que entrega `string` | o driver `pg` já retorna `numeric` como string, sem passar por `number` |
| IDs | UUID v7 (`Bun.randomUUIDv7()`) | ordenável no tempo, bom para índices B-tree |
| Conexões | pool por instância (`DB_POOL_MAX`); `DATABASE_READ_URL` opcional para leituras sem *read-your-writes* |
| Isolamento | `READ COMMITTED` + locks explícitos | previsível; `SERIALIZABLE` geraria muitos aborts em hot wallet |
| Timeouts | `SET LOCAL lock_timeout = '5s'` e `SET LOCAL statement_timeout = '10s'` em cada transação (compatível com pooler) | evita fila infinita de locks; o timeout vira erro transitório (`503`/retry) |

## 6. Estratégia de concorrência

**Escolha:** lock pessimista por wallet (`SELECT … FOR UPDATE` na linha da wallet) dentro de uma transação curta, com `CHECK (balance >= 0)` e `version` como redes de segurança.

| Alternativa | Por que não como estratégia principal |
|---|---|
| Optimistic lock + retry | em hot wallet (muitas apostas na mesma wallet) gera retries em cascata e latência imprevisível |
| `UPDATE … WHERE balance >= x` atômico | correto para o saldo, mas não serializa a checagem de idempotência nem a validação de referência |
| Advisory lock | funciona, mas lock de linha é mais simples, já cobre o caso e é liberado no commit/rollback |
| Lock global | proibido (restrição 6) |

**Um único lock por operação:** a wallet (`FOR UPDATE`). A transação referenciada é lida **sem**
lock: se for válida, pertence à mesma wallet, e toda mudança nela acontece sob esse mesmo lock;
reversões concorrentes da mesma referência já são serializadas por ele, e o índice
`uq_tx_single_reversal` é a última barreira. (Até a I8 havia um `FOR UPDATE` na referência; a
revisão técnica mostrou que ele só tinha efeito numa referência de **outra** wallet — o caso
inválido — onde travava uma linha alheia e abria espaço para deadlock entre wallets.)

Toda transação toca **uma única wallet**, então não há ciclo entre wallets.

**Por que a idempotência fica correta sob concorrência:** duas requisições idênticas disputam o mesmo lock de wallet. A segunda só prossegue depois do commit da primeira. Em `READ COMMITTED`, cada statement enxerga os commits anteriores, então ela encontra a transação pela `idempotency_key` e responde com replay. Para wallet inexistente ou corridas raras, o `UNIQUE` do banco é a última barreira: a violação vira releitura e replay.

## 7. Schema (rascunho das constraints)

```sql
CREATE TABLE wallets (
  id          uuid PRIMARY KEY,
  player_id   uuid        NOT NULL,
  currency    char(3)     NOT NULL,
  balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
  version     integer     NOT NULL CHECK (version >= 1),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id                                uuid PRIMARY KEY,
  provider_id                       text NOT NULL,
  external_transaction_id           text NOT NULL,
  idempotency_key                   text NOT NULL,
  payload_hash                      char(64) NOT NULL,
  wallet_id                         uuid NOT NULL REFERENCES wallets(id),
  player_id                         uuid NOT NULL,
  round_id                          text,
  game_id                           text,
  kind                              text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
  currency                          char(3) NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid REFERENCES wager_transactions(id),
  status                            text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code                      text,
  balance_after                     numeric(20,2),          -- snapshot para replay (D-05)
  attempts                          integer NOT NULL DEFAULT 0,
  next_attempt_at                   timestamptz,
  created_at                        timestamptz NOT NULL,
  processed_at                      timestamptz,
  CONSTRAINT uq_tx_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT ck_tx_reference_required CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT ck_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
  CONSTRAINT ck_tx_round_required CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
  CONSTRAINT ck_tx_failure_code CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL))
);

-- reversão única por referência (D-01)
CREATE UNIQUE INDEX uq_tx_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';

-- fila do worker de pending reference
CREATE INDEX ix_tx_pending_reference ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- consultas antifraude por jogador/tempo (D-19, alertas do doc 06)
CREATE INDEX ix_tx_player_time ON wager_transactions (player_id, created_at)
  WHERE kind IN ('BET','REFUND','ROLLBACK');

CREATE TABLE wallet_ledger_entries (
  id              uuid PRIMARY KEY,
  wallet_id       uuid NOT NULL REFERENCES wallets(id),
  wallet_version  integer NOT NULL,            -- sequência por wallet = cursor estável
  transaction_id  uuid NOT NULL REFERENCES wager_transactions(id),
  direction       text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount          numeric(20,2) NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL,
  balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
  created_at      timestamptz NOT NULL,
  CONSTRAINT uq_ledger_tx_wallet UNIQUE (transaction_id, wallet_id),
  CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
  CONSTRAINT ck_ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount))
);

-- imutabilidade estrutural
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- (TRUNCATE também bloqueado por trigger de statement; usuário da aplicação sem GRANT de UPDATE/DELETE)

-- consistência wallet ↔ ledger no commit (defesa em profundidade)
-- CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED em wallets: ao alterar balance,
-- exige um lançamento com (wallet_id, wallet_version = NEW.version, balance_after = NEW.balance).

-- trilha de auditoria: 1 linha por decisão sobre uma transação (D-18)
CREATE TABLE wager_transaction_audit (
  id                     uuid PRIMARY KEY,
  transaction_id         uuid NOT NULL REFERENCES wager_transactions(id),
  wallet_id              uuid NOT NULL REFERENCES wallets(id),
  action                 text NOT NULL CHECK (action IN (
                           'PROCESSED','REJECTED','PENDING_REFERENCE','RETRY_SCHEDULED',
                           'FAILED','IDEMPOTENT_REPLAY','IDEMPOTENCY_CONFLICT','REVERSED_BY')),
  from_status            text,
  to_status              text,
  failure_code           text,
  ledger_entry_id        uuid REFERENCES wallet_ledger_entries(id),  -- para onde foi o dinheiro
  related_transaction_id uuid REFERENCES wager_transactions(id),     -- referência / reversão vencedora
  source                 text NOT NULL CHECK (source IN ('HTTP','SQS','WORKER','INTERNAL')),
  correlation_id         text NOT NULL,
  message_id             text,                                        -- quando veio do SQS
  instance_id            text NOT NULL,                               -- qual réplica decidiu
  details                jsonb NOT NULL DEFAULT '{}',                 -- sem dados sensíveis
  occurred_at            timestamptz NOT NULL
);
CREATE INDEX ix_audit_tx_time     ON wager_transaction_audit (transaction_id, occurred_at);
CREATE INDEX ix_audit_wallet_time ON wager_transaction_audit (wallet_id, occurred_at);
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON wager_transaction_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Replay e conflito também gravam auditoria: o caminho de replay faz COMMIT de 1 linha
-- de auditoria em vez de ROLLBACK. Erros sem transação persistida (400, WALLET_NOT_FOUND)
-- ficam só em log/métrica, pois não há agregado a que se vincular.

CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id    text NOT NULL,
  payload_hash  char(64) NOT NULL,
  received_at   timestamptz NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id              uuid PRIMARY KEY,            -- = eventId
  aggregate_id    uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  locked_until    timestamptz,
  locked_by       text,
  published_at    timestamptz
);
CREATE INDEX ix_outbox_pending ON outbox_messages (occurred_at, id) WHERE published_at IS NULL;  -- I8: era (next_attempt_at); ver relatório de carga
```

## 8. Mensageria

| Item | Decisão |
|---|---|
| Fila de entrada | `wager-transactions.fifo`, `MessageGroupId = walletId` (ordem por wallet como otimização) |
| DLQ | `wager-transactions-dlq.fifo`, redrive `maxReceiveCount = 5` |
| Eventos | `wagering-events.fifo`, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId` |
| Visibilidade | 60 s; o backoff de erros transitórios usa `ChangeMessageVisibility` (2ⁿ s, com jitter) |
| Ack | `DeleteMessage` só **depois** do commit |
| Inbox | `INSERT … ON CONFLICT DO NOTHING` na mesma transação. Com 0 linhas inseridas, é duplicata → ack |
| Outbox claim | `UPDATE … SET locked_until = now()+30s, locked_by = :instance WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *` |
| Outbox publish | `SendMessageBatch` (até 10), fora da transação do claim; sucesso → `published_at`; falha → `scheduleRetry` (backoff exponencial, teto de 5 min) |
| Garantia | *at-least-once*: o consumidor deduplica por `eventId`, e `walletVersion` no evento permite ordenar |

**Classificação de erros no consumidor:**

| Tipo | Exemplos | Ação |
|---|---|---|
| Negócio | `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, replay | commit (quando aplicável) → `DeleteMessage` |
| Transitório | Postgres fora, `lock_timeout`, falha de rede | não deleta; `ChangeMessageVisibility` com backoff; depois de 5 recebimentos o redrive manda para a DLQ |
| Permanente | JSON inválido, schema inválido, `type` desconhecido, payload divergente do inbox | `SendMessage` para a DLQ + `DeleteMessage` (sem esperar o redrive) |

## 9. Worker de referências pendentes (§7.1)

- Faz claim com `FOR UPDATE SKIP LOCKED` sobre `status = 'PENDING_REFERENCE' AND next_attempt_at <= now()`. Assim, várias instâncias trabalham em paralelo sem pegar a mesma linha.
- Para cada pendência, **primeiro tenta resolver a referência** (travando a wallet, pelo mesmo fluxo do use case). Só se ela continuar ausente consulta a política.
- A decisão é da `ReferenceRetryPolicy` (domínio, pura e testada — UT-R01..R06):

| Parâmetro | Valor | Justificativa |
|---|---|---|
| Primeira tentativa | 1 s após virar `PENDING_REFERENCE` | a referência costuma chegar em milissegundos/segundos |
| Backoff | `min(1 s × 2ⁿ, 60 s)` + jitter de até 20% | sequência 1, 2, 4, 8, 16, 32, 60, 60, 60, 60 s; o jitter evita que pendências da mesma rajada acordem juntas |
| Limite de tentativas | **10** (≈ 4 min no total) | provedores reenviam a referência em segundos; mais tempo só atrasa a reconciliação do provedor |
| TTL | **15 min** desde a criação | rede de segurança quando o worker ficou parado; avaliado antes do limite de tentativas |
| Esgotado | `REJECTED REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected` na outbox, na mesma transação | exigido pelo §7.1; o provedor recebe um código estável e pode conciliar |

- Otimização opcional: ao processar uma transação, agendar `next_attempt_at = now()` para as dependentes que apontam para ela.

### 9.1 Todas as políticas de retry do sistema

| Laço | Gatilho | Backoff | Limite | Ao esgotar | Métrica (§12) |
|---|---|---|---|---|---|
| **Referência pendente** (§7.1) | referência ainda ausente | `min(1 s × 2ⁿ, 60 s)` + jitter 20% | 10 tentativas ou TTL 15 min | `REJECTED REFERENCE_NOT_FOUND` + evento | `retries_total{component="pending_worker"}`, `pending_references` |
| **Consumidor SQS** (§10) | erro transitório ou desconhecido (Postgres/DNS/rede fora, `lock_timeout`) | `ChangeMessageVisibility` = `min(2ⁿ s, 300 s)` + jitter, com n = `ApproximateReceiveCount` (2, 4, 8, 16 s…); as **seguintes do mesmo grupo voltam junto**, sem processar (ordem FIFO) | `maxReceiveCount = 5` | na **última recepção**: `FAILED INFRA_RETRIES_EXHAUSTED` + auditoria + `WagerTransactionFailed` e DLQ `retries_exhausted` pela aplicação; se nem isso for possível (banco fora), DLQ sem registro. O redrive do SQS fica como rede de segurança (processo caindo em loop) e aparece em `queue_depth{queue="wager_dlq"}` | `retries_total{component="consumer"}`, `dlq_messages_total{reason}`, `queue_depth` |
| **Consumidor SQS** — erro permanente | JSON/schema inválido, `type` desconhecido, payload divergente no inbox, categoria `permanent` | sem retry | — | DLQ imediata + `DeleteMessage` | `dlq_messages_total{reason}` |
| **Consumidor SQS** — erro de programação | `InvariantViolationError`, `TypeError`/`RangeError`/`ReferenceError` sem `code` de sistema | sem retry: reprocessar daria o mesmo erro | — | DLQ imediata, motivo `bug` | `dlq_messages_total{reason="bug"}` |
| **Consumidor SQS** — erro de negócio | ex.: `INSUFFICIENT_FUNDS` | sem retry (resultado já persistido) | — | ack | `wager_transactions_total{status="REJECTED"}` |
| **Consumidor SQS** — rejeição sem transação | conflito de idempotência, wallet inexistente | sem retry | — | ack + evento `WagerOperationRejected` (o provedor não tem resposta síncrona) | `duplicates_detected_total`, `errors_total` |
| **Publisher da outbox** (§11) | falha ao publicar no SQS | `min(1 s × 2ⁿ, 5 min)` (`OutboxMessage.scheduleRetry`) | **sem limite**: um evento confirmado nunca é descartado | alerta de `outbox_lag_seconds`; o lease garante que outra instância assuma | `retries_total{component="outbox"}`, `outbox_lag_seconds` |
| **Lock da wallet** (HTTP) | `lock_timeout` de 5 s | sem retry no servidor | — | `503` + `Retry-After`; o provedor reenvia com a mesma `Idempotency-Key` (seguro por idempotência) | `lock_timeouts_total`, `lock_conflicts_total` |

## 10. Convenções de código

- TS `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Proibido `number` em qualquer campo monetário. Uma regra de lint barra `parseFloat`/`Number(` nos módulos de domínio.
- Arquivos em `kebab-case` (`wager-transaction.ts`); classes em `PascalCase`; tokens de porta em `UPPER_SNAKE` (`WALLET_REPOSITORY`).
- Use cases recebem *commands* imutáveis (`readonly`) e retornam DTOs de resultado, nunca entidades ORM.
- Commits no padrão Conventional Commits (`feat(wagering): …`, `test(wallet): …`).
- Formatação e lint com Biome, que é rápido, roda bem com Bun e reúne lint e format numa ferramenta só.
