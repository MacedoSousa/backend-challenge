# ARCHITECTURE

> Registro das decisões técnicas, trade-offs e limitações do **Distributed Wagering Processor**.
> Detalhamento em [`docs/`](./docs). Este documento é vivo: cada decisão nova entra como ADR.

## Visão geral

Monólito modular NestJS sobre Bun, com arquitetura hexagonal. A mesma imagem roda em N réplicas e assume papéis (`api`, `consumer`, `outbox`, `scheduler`). PostgreSQL é a **fonte da verdade** de todas as invariantes. O SQS serve como transporte *at-least-once*, e a ordenação FIFO é usada apenas como otimização.

Diagramas: [docs/05-diagramas.md](./docs/05-diagramas.md).

## Registro de decisões (ADR)

| # | Decisão | Alternativas consideradas | Trade-off aceito |
|---|---|---|---|
| ADR-01 | **MikroORM** com registros de persistência mapeados por `EntitySchema` (sem decorators) e separados do domínio; mappers fazem a ponte via `rehydrate` | TypeORM; decorators nas classes de domínio | mais código de mapeamento, em troca de um domínio puro e de evitar dependência de `reflect-metadata` nos tipos de coluna |
| ADR-02 | `Money` com **`bigint` em centavos** (escala fixa 2); `NUMERIC(20,2)` no banco; string decimal na borda | `decimal.js`, `big.js` | não suporta moedas com escala ≠ 2 (fora do escopo) |
| ADR-03 | **Lock pessimista por wallet** (`SELECT … FOR UPDATE`) + `CHECK (balance >= 0)` + `version` | optimistic + retry; `UPDATE` condicional; advisory lock | throughput de uma única hot wallet fica serializado (correto por definição) |
| ADR-04 | Isolamento `READ COMMITTED`, `lock_timeout 5s` → erro transitório | `SERIALIZABLE` | depende da disciplina de lock explícito |
| ADR-05 | Idempotência por `UNIQUE (idempotency_key)` **e** `UNIQUE (provider_id, external_transaction_id)`; `payloadHash` = SHA-256 do JSON canônico | cache/Redis | uma consulta extra por requisição |
| ADR-06 | Snapshot `balance_after` na transação para replay fiel | derivar do ledger | coluna redundante (necessária para `LOSS`/`REJECTED`) |
| ADR-07 | Rejeição de negócio é **persistida** (`REJECTED`) e idempotente | apenas responder erro | mais linhas no banco, em troca de auditoria completa |
| ADR-08 | Reversão única por referência, **qualquer tipo** (índice único parcial). `REFUND` e `ROLLBACK` compartilham **um único fluxo** (`ReverseTransaction`); a primeira vence e a segunda é rejeitada apontando a vencedora | leitura literal "mesmo tipo"; segurar o `REFUND` até "confirmar que não haverá rollback"; checar "mesmo usuário + mesmo valor na última 1 h" e responder "aguarde" (bloqueia apostas diferentes de mesmo valor, deixa passar duplicata após a janela, não é idempotente) | mais restritivo que o enunciado; evita crédito duplo. A espera foi descartada porque não há sinal de fim de rodada, ambas creditam o mesmo valor sobre a `BET` e todo reembolso seria atrasado |
| ADR-09 | Transactional Outbox com claim por **lease** + `FOR UPDATE SKIP LOCKED` | LISTEN/NOTIFY; CDC (Debezium) | publicação duplicada possível após expiração de lease (consumidor deduplica por `eventId`) |
| ADR-10 | Inbox `(consumer_name, message_id)` na mesma transação SQL | dedup do SQS FIFO | a janela de 5 min do SQS não basta e não é garantia |
| ADR-11 | Erros do consumidor: negócio → ack; transitório → backoff de visibilidade; permanente → DLQ imediata | só redrive | lógica de classificação explícita |
| ADR-12 | Worker de pendências: primeira tentativa em 1 s, backoff `min(2^n s, 60 s)` + jitter 20%, **10 tentativas / TTL 15 min** (o que vier primeiro), implementado como `ReferenceRetryPolicy` pura no domínio | TTL longo (horas) | provedor que demora mais que ~4 min recebe `REFERENCE_NOT_FOUND`. Tabela de todos os retries em docs/03 §9.1 |
| ADR-13 | Eventos publicados em `wagering-events.fifo` | SNS fan-out | um destino só; fácil de trocar atrás da porta `MessagePublisher` |
| ADR-14 | Ledger imutável por **trigger** + sem `GRANT UPDATE/DELETE` | só convenção | migrations administrativas precisam de role própria |
| ADR-15 | Cursor do ledger = `wallet_version` (opaco em base64url) | `created_at, id` | estável e sem colisão por definição |
| ADR-16 | Autenticação **não implementada**: `AuthGuard` no-op + `ProviderIdentityPort`; desenho alvo com Keycloak (client credentials por provedor, `providerId` vindo do token e não do body) | Keycloak no compose | vale 0 pontos; o timebox vai para correção |
| ADR-17 | Validação com **zod**, o mesmo schema para HTTP e SQS | `class-validator` | sai do idioma mais comum do Nest |
| ADR-18 | IDs UUID v7 | UUID v4, ULID | — |
| ADR-19 | **Trilha de auditoria** `wager_transaction_audit`, append-only, 1 linha por decisão (inclusive replay e conflito), na mesma transação SQL; ligada ao lançamento (`ledger_entry_id`) e à transação relacionada | só logs estruturados; event sourcing completo | mais escrita por requisição (replays passam a fazer commit), em troca de responder por SQL "para onde foi o dinheiro e o que aconteceu" |
| ADR-20 | Observabilidade **100% gratuita e local**: OpenTelemetry + pino → `grafana/otel-lgtm` (Grafana, Prometheus, Loki, Tempo), `postgres-exporter`, Grafana com fonte PostgreSQL para dados exatos, Grafana Alerting → e-mail (Mailpit por padrão; SMTP real opcional via `.env`) | Datadog (pago após trial); dashboard próprio; Prometheus + Alertmanager avulsos | o repositório é público: roda sem conta nem chave e não versiona segredos |
| ADR-21 | **Relatório de incidente por e-mail**: o Grafana detecta e chama um webhook; o módulo `alerting` (papel `notifier`, banco read-only) enriquece com último cliente afetado (mascarado), impacto, atraso, gargalo (heurísticas determinísticas), filas e desfecho, e envia por SMTP (Mailpit local). Idempotente por `(fingerprint, startsAt)` na tabela `incidents`. Níveis crítico/médio/leve com políticas de reenvio; os leves vão num resumo horário | só template nativo do Grafana; notificador próprio que também detecta | mais um componente, isolado do caminho financeiro; fallback nativo do Grafana se ele cair |
| ADR-22 | **Versões fixadas em majors maduras**: NestJS 11.2, MikroORM 6.6, TypeScript 5.9 (só typecheck; o Bun transpila), Testcontainers 11, zod 4, Bun 1.4.2. Dependências com versão exata | NestJS 12 (lançado há 6 semanas), MikroORM 7, TypeScript 7 (compilador nativo) | upgrade de major planejado depois da entrega, com a suíte de testes como rede |
| ADR-23 | **Balanceador nginx** na frente das réplicas no Compose, com `resolve` dinâmico, `proxy_connect_timeout 1s` e nova tentativa em outra réplica (só GET; POST nunca é repetido pelo proxy) | Traefik; acessar réplicas por portas diferentes | uma peça a mais; em produção seria o load balancer da plataforma |
| ADR-24 | **Sessão única por jogador fora do núcleo**: a proteção financeira contra jogar o mesmo saldo em dois jogos é o lock da wallet + `CHECK (balance >= 0)`. Fica uma porta `PlayerSessionPolicy` (no-op) chamada antes de cada `BET`, com `failureCode` reservado `CONCURRENT_GAME_NOT_ALLOWED`, e um alerta antifraude de jogos simultâneos | bloquear `BET` em outro jogo até a rodada anterior terminar | sem sinal confiável de fim de rodada; um `LOSS` perdido travaria o jogador |
| ADR-25 | **`playerId` opaco** (UUID emitido pela plataforma, validado no contrato), nunca dado pessoal | aceitar qualquer string | o provedor precisa mapear seu ID interno para o UUID da plataforma |
| ADR-26 | **FKs `DEFERRABLE INITIALLY DEFERRED`** + triggers de integridade: cadeia do ledger (`balance_before` = `balance_after` anterior, mesma moeda da wallet) e constraint trigger diferido que exige saldo e versão da wallet iguais ao último lançamento no COMMIT | ordenar INSERTs manualmente; confiar só no domínio | triggers custam algumas leituras por escrita; em troca, nem um bug nem um SQL manual consegue deixar saldo e ledger divergentes |
| ADR-27 | **Unit of Work como porta** (`UnitOfWork.run(scope => …)`): cada execução usa um `EntityManager` novo (`fork`) e uma transação própria; erros do driver são traduzidos (unicidade → `UniqueConstraintViolation`; conexão, `lock_timeout`, `statement_timeout` → `INFRA_UNAVAILABLE` / 503) | use cases chamando `em.transactional` direto | use cases testáveis e sem dependência do ORM; o mesmo UoW serve HTTP, consumidor e workers |
| ADR-28 | **Métricas por instância** (`/metrics` em cada réplica, prom-client); o Prometheus deve coletar cada réplica, nunca pelo balanceador | agregador central; push gateway | contadores ficam por processo (somados no Prometheus); verificado no Compose: pelo balanceador cada coleta cai numa réplica diferente |

Interpretações de requisitos ambíguos: [docs/01-analise-requisitos.md §6](./docs/01-analise-requisitos.md#6-ambiguidades-e-decisões-adotadas).

## Adaptações das assinaturas sugeridas (§6)

O enunciado permite adaptar nomes e assinaturas "desde que as garantias sejam preservadas". Adaptações feitas, todas cobertas por testes:

| Classe | Esqueleto do enunciado | Implementação | Por quê | Garantia preservada |
|---|---|---|---|---|
| `Money` | `private readonly value: Decimal` | `private readonly minorUnits: bigint` (centavos) | escala fixa 2: aritmética exata sem biblioteca (ADR-02) | imutável, exato, sem `number` |
| `Money.from` | aceita string decimal | aceita **só** a forma canônica `"25.00"` (D-06) | §6.1 "recebido … sempre com escala fixa de 2 casas" | rejeita NaN, Infinity, notação científica, vazio, > 2 casas, negativos |
| `Wallet.open` | `open(props): Wallet` | `open(props): { wallet, openingEntry? }` | o saldo inicial precisa nascer com seu lançamento `CREDIT`, sem quebrar `version = 1` | toda alteração de saldo tem lançamento; `version` inicia em 1 |
| `Wallet.debit/credit` | assinatura livre | `(money, movement) → WalletLedgerEntry`; `movement.cause` escolhe `INSUFFICIENT_FUNDS` ou `REVERSAL_INSUFFICIENT_FUNDS` | saldo e ledger nascem juntos; códigos distintos (regra 9) | saldo nunca negativo |
| `WalletLedgerEntry` | campos do esqueleto | + `walletVersion` | sequência contínua por wallet, cursor estável do ledger, `UNIQUE (wallet_id, wallet_version)` | imutável, aritmética validada |
| `WagerTransaction.markProcessed` | `(referenceTransactionId, at)` | `({ at, balanceAfter, referenceTransactionId? })` | guarda o saldo observado para o replay fiel (regra 7) | terminais imutáveis |
| `WagerTransaction.reject` | `(code)` | `(code, { at, balanceAfter, referenceTransactionId?, relatedTransactionId? })` | replay de rejeição + aponta a reversão vencedora (D-01) | só aceita códigos de negócio |
| `WagerTransaction.markPendingReference` | `()` | `(nextAttemptAt)` + `scheduleReferenceRetry(nextAttemptAt)` + `attempts` | o worker do §7.1 precisa de backoff persistido | transições explícitas |
| `WagerTransaction` | — | + `createOpening(...)` | `OPENING` só nasce por esta factory interna; `create()` o recusa | `OPENING` nunca vem da API/fila |
| Eventos | `aggregateId` livre | `aggregateId = walletId` em todos | ordem por wallet na fila FIFO (D-08) | envelope e `data` em `MoneyProps` |

## Garantias e onde vivem

Ver a matriz completa em [docs/01 §5](./docs/01-analise-requisitos.md#5-matriz-regra--onde-é-imposta). Resumo: **o domínio valida primeiro, e o banco impede o que o domínio deixar passar.**

## Taxonomia de falhas e HTTP

Ver [docs/01 §7–8](./docs/01-analise-requisitos.md#7-taxonomia-de-failurecode).

## Observabilidade

Detalhes, catálogo de métricas, dashboards e alertas: [docs/06-observabilidade.md](./docs/06-observabilidade.md). Erros HTTP seguem RFC 9457 (`application/problem+json`) com `failureCode` e `correlationId`.

- **Logs:** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Redaction de payloads e valores.
- **Métricas** (`/metrics`, Prometheus):
  - `wager_transactions_total{status,kind}`, `duplicates_detected_total{source}`, `retries_total{component}`;
  - `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `processing_duration_seconds` (histograma);
  - `reconciliation_divergence_total`.
- **Health:** `/health/live` (processo) e `/health/ready` (Postgres `SELECT 1` + SQS `GetQueueAttributes`).

## Escalabilidade

**Resumo:** a aplicação escala horizontalmente; o teto é o PostgreSQL primário. Isso é suficiente para o que o desafio avalia (correção com ≥ 3 instâncias), e o desenho preserva um caminho de crescimento sem reescrever o domínio.

### O que escala horizontalmente

| Componente | Como escala | Por quê funciona |
|---|---|---|
| API HTTP | mais réplicas atrás de um balanceador | sem estado em memória; idempotência e locks estão no banco |
| Consumidores SQS | mais réplicas `APP_ROLE=consumer` | `MessageGroupId = walletId`: grupos distintos em paralelo; inbox no banco |
| Publisher da outbox | mais réplicas `APP_ROLE=outbox` | claim com `FOR UPDATE SKIP LOCKED` + lease |
| Worker de pendências | mais réplicas `APP_ROLE=scheduler` | mesmo mecanismo de claim |
| Concorrência entre wallets | linear até o limite do banco | lock por linha de wallet, sem lock global |

**Propriedade-chave:** toda transação financeira toca **uma única wallet**. Isso torna o sistema naturalmente particionável por `walletId` no futuro.

### Limites conhecidos

| Limite | Natureza | Posição |
|---|---|---|
| **Hot wallet** | operações da mesma wallet são serializadas; o throughput por wallet ≈ 1 / duração da transação SQL | **aceito por desenho**: é a garantia de correção. Medido no ST-03 |
| **Postgres primário único** | toda escrita passa por ele; cada transação ≈ 6 escritas (wallet, transação, ledger, auditoria, 2 eventos de outbox) | teto real do sistema; medido no ST-02 e no ST-08 |
| **Crescimento de tabelas** | ledger, auditoria, transações, inbox e outbox só crescem | inbox/outbox com retenção; ledger/auditoria **nunca** são apagados |
| **Conexões** | réplicas × tamanho do pool ≤ `max_connections` − reserva | pool explícito por instância (`DB_POOL_MAX`) |
| **Cota do SQS FIFO** | ~300 req/s por ação sem lote; ~3.000 com lote; mais no modo *high throughput* | publicação e consumo em lote |
| **Amplificação de escrita da auditoria** | replays também gravam auditoria | aceito (ADR-19); é o custo de auditar tudo |

### Entra agora (no escopo)

| # | Medida | Onde |
|---|---|---|
| S-1 | Publicação da outbox com `SendMessageBatch` (até 10 por chamada) e consumo com `MaxNumberOfMessages=10` | E4-2, E5-1 |
| S-2 | Job de retenção: remove, em lotes pequenos, inbox processada e outbox publicada há mais de 7 dias (configurável). Ledger e auditoria são intocáveis (trigger) | E4-4 |
| S-3 | Conexão de leitura separada (`DATABASE_READ_URL`, padrão = primário) para listagem do ledger, reconciliação, notificador e Grafana. Consultas logo após uma escrita (`GET` da transação/wallet) continuam no primário (*read-your-writes*) | E2-5 |
| S-4 | Pool por instância configurável (`DB_POOL_MAX`), com a conta de conexões documentada no README | E0-3 |
| S-5 | Timeouts com `SET LOCAL` (escopo de transação), compatível com um pooler no futuro | E3-1 |
| S-6 | Teste de escala horizontal (ST-08): mesma carga com 1 e 3 instâncias, registrando ganho e onde satura (CPU do banco, locks, pool) | E8-4 |

### Caminho de evolução (documentado, não implementado)

Cada passo é disparado por um **sinal medido** nos dashboards, nunca por antecipação:

| Sinal | Próximo passo | Custo / cuidado |
|---|---|---|
| conexões perto do limite | **PgBouncer** em *transaction pooling* | nada de estado de sessão: timeouts via `SET LOCAL` (S-5), sem advisory locks de sessão |
| tabelas grandes, `VACUUM` e índices lentos | **particionamento por mês** de ledger, auditoria e transações (`pg_partman`) | a chave de partição entra na PK e nos `UNIQUE`; exige migration planejada |
| leitura competindo com escrita | **réplica de leitura** apontada em `DATABASE_READ_URL` (S-3) | lag de replicação: a reconciliação usa snapshot da própria réplica e informa o horário de referência |
| CPU/IO do primário saturados após escala vertical | **sharding por `walletId`** (ex.: Citus, com tabelas co-localizadas por `wallet_id`) | transações de uma única wallet = um shard só. **Mas** `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` são globais e precisariam de uma tabela de lookup própria ou passar a incluir `wallet_id` |
| fila FIFO perto da cota | **high throughput FIFO** e mais grupos de mensagem | ordenação continua por `walletId` |
| hot wallet real (um jogador saturando) | fora do escopo; revisitar modelo (ex.: limites de taxa por jogador) | qualquer solução que paralelize a mesma wallet reabre o risco de saldo negativo |

**O que deliberadamente não fazemos agora:** sharding, Kafka, CQRS com banco de leitura separado, cache de saldo. Tudo isso adiciona complexidade e pontos de falha sem necessidade comprovada, e o desafio pontua simplicidade.

## Limitações conhecidas

- Moeda com escala fixa de 2 casas. Reversão parcial está fora do escopo.
- Hot wallet tem throughput limitado pela serialização (por desenho).
- Entrega de eventos é *at-least-once*: consumidores precisam deduplicar por `eventId`.
- Reconciliação é sob demanda (não há job periódico).

_Seções a completar durante a implementação: resultados de carga, decisões revistas._
