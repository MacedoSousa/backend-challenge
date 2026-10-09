# 07 — Conformidade com o enunciado

> Matriz **item do enunciado → onde é atendido → teste que prova → situação**. Revisada ao fim de cada iteração; um item só vira ✅ com teste passando.
>
> Legenda: ✅ feito e testado · 🟡 planejado (iteração) · ⚠️ interpretação documentada · ➖ opcional, fora do obrigatório

**Última revisão:** fim da Iteração 1 — 208 testes de unidade, 7 de integração.

## Resumo

| § | Tema | Situação |
|---|---|---|
| 1 | Visão geral | 🟡 núcleo em I2–I6 |
| 2 | Autenticação | ✅ decisão + ponto de extensão · 🟡 validação da identidade na fila (I5) |
| 3 | Contexto do domínio (at-least-once) | 🟡 cenários mapeados para testes |
| 4 | Stack | ✅ |
| 5 | Restrições invioláveis | ✅ 1, 3, 6, 8 · 🟡 2, 4, 5, 7, 9 |
| 6 | Modelo de domínio | ✅ classes e invariantes de domínio · 🟡 garantias de schema (I2) |
| 7 | Regras de negócio, referências, failure codes | ✅ domínio · 🟡 persistência e worker (I3, I5) |
| 8 | Concorrência | ✅ estratégia · 🟡 testes (I3, I6) |
| 9 | API HTTP | ✅ health, hash canônico · 🟡 demais endpoints (I2, I3) |
| 10 | SQS | ✅ topologia e DLQ · 🟡 consumidor (I5) |
| 11 | Outbox e eventos | ✅ envelope e eventos · 🟡 persistência e publisher (I3, I4) |
| 12 | Observabilidade | ✅ logs, health · 🟡 métricas (I3–I5) |
| 13 | Testes obrigatórios | ✅ unidade · 🟡 integração e concorrência |
| 14 | Avaliação / documentação | ✅ README, ARCHITECTURE em dia |

## §1 Visão geral

| Foco da avaliação | Onde | Situação |
|---|---|---|
| Correção financeira | `Money`, `Wallet`, ledger (I1); schema (I2); reconciliação (I2) | ✅ domínio · 🟡 I2 |
| Concorrência entre múltiplas instâncias | lock por wallet (ADR-03); Compose com 3 réplicas (I0) | 🟡 I3, I6 |
| Idempotência persistente | `UNIQUE` + snapshot de saldo (ADR-05, ADR-06); `payloadHash` (I1) | 🟡 I3 |
| Consistência saldo × ledger | `Wallet` devolve o lançamento; sequência `walletVersion` | ✅ domínio · 🟡 trigger diferido (I2) |
| Processamento assíncrono e recuperação | inbox, outbox, worker, DLQ | 🟡 I4, I5 |
| Clareza das decisões | ARCHITECTURE.md (25 ADRs), docs/01 §6 (20 decisões) | ✅ |

## §2 Autenticação

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Não implementar → documentar decisão e desenho | ADR-16 | — | ✅ |
| Ponto de extensão explícito no código | `AuthGuard` no-op + `ProviderIdentityPort` (`src/modules/auth/auth.module.ts`) | — | ✅ |
| Nada de tabela própria de usuários/senhas | não existe | — | ✅ |
| Health sem autenticação | `@Public()` no `HealthController` | IT-21 (`bootstrap.spec.ts`) | ✅ |
| Identidade do provedor na mensagem passa pelas validações de domínio | mesmo use case para HTTP e SQS | IT-29 via fila (I5) | 🟡 I5 |

## §3 Contexto do domínio

| Premissa | Teste que a cobre | Situação |
|---|---|---|
| Mesma operação várias vezes | CT-01 (50× paralelo), IT-09, IT-12 | 🟡 I3, I5 |
| Dependente antes da referência | UT-T15, UT-R01..R05 ✅; CT-07 | ✅ domínio · 🟡 I5 |
| Várias instâncias na mesma wallet | CT-02, CT-04, CT-09, CT-12 | 🟡 I3, I6 |
| Processo morre antes/depois do commit | IT-07, CT-05, CT-08 | 🟡 I3, I6 |
| Eventos publicados mais de uma vez | IT-16, CT-06 | 🟡 I4 |
| Postgres e SQS indisponíveis | IT-21 ✅; IT-13, IT-17 | ✅ health · 🟡 I4, I5 |
| **Invariantes:** sem crédito/débito duplicado, sem perder evento, sem saldo negativo | UT-W04, UT-T13/T17 ✅; CT-01, CT-02, CT-12, IT-02, IT-06 | ✅ domínio · 🟡 banco |

## §4 Stack

| Item | Onde | Situação |
|---|---|---|
| Bun 1.x (runtime, gerenciador, testes) | `package.json`, `Dockerfile` (`oven/bun:1.4.2-slim`) | ✅ |
| TypeScript estrito | `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | ✅ |
| NestJS | `src/app.module.ts` | ✅ |
| PostgreSQL | `compose.yaml`, Testcontainers | ✅ |
| SQS via LocalStack | `compose.yaml`, `src/shared/infrastructure/sqs/queues.ts` | ✅ |
| Docker Compose | `compose.yaml` (setup, 3 réplicas, nginx) | ✅ |
| Migrations versionadas e reversíveis | `src/database/migrations/` — IT-01 (up → down → up) | ✅ |
| MikroORM (preferencial) | `src/database/mikro-orm.config.ts` | ✅ |
| Justificar ORM, mapeamento do `Money` e estratégia transacional | ADR-01, ADR-02, ADR-03, ADR-04 | ✅ (custom type do `Money`: 🟡 I2) |

## §5 Restrições invioláveis

| # | Restrição | Onde é garantida | Teste | Situação |
|---|---|---|---|---|
| 1 | Sem `number`/`float` para dinheiro | `Money` com `bigint`; `NUMERIC(20,2)` | teste de arquitetura (proíbe `parseFloat`, `Number(`, `toFixed`…) | ✅ |
| 2 | Idempotência não em memória | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, inbox | IT-09, IT-10, CT-01 | 🟡 I3 |
| 3 | Não confiar só no FIFO | banco é a garantia final (D-08, ADR-10) | IT-12, CT-05 | ✅ desenho · 🟡 testes |
| 4 | Evento só após commit | outbox na mesma transação (ADR-09) | IT-07, CT-05 | 🟡 I4 |
| 5 | Ledger sem sobrescrita/exclusão | `WalletLedgerEntry` congelado ✅; `forbid_mutation()` ✅; trigger na tabela | UT-L02 ✅; IT-03 | ✅ domínio · 🟡 I2 |
| 6 | Sem lock global | lock por linha de wallet (ADR-03) | CT-03 | ✅ desenho · 🟡 teste |
| 7 | Sem `read → calculate → update` sem controle | `SELECT … FOR UPDATE` + `CHECK` | CT-02, CT-12 | 🟡 I3 |
| 8 | Correta com múltiplas instâncias | Compose com 3 réplicas (I0) | CT-04 | ✅ ambiente · 🟡 teste |
| 9 | Garantias no **schema** | `CHECK`, `UNIQUE`, índice parcial, triggers (docs/03 §7) | IT-02..06 | 🟡 I2 |

## §6 Modelo de domínio

Adaptações de assinatura: [ARCHITECTURE.md → Adaptações](../ARCHITECTURE.md#adaptações-das-assinaturas-sugeridas-6).

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| **6.0** Construtor privado + factories `create`/`from`/`rehydrate` | todas as classes de domínio | — | ✅ |
| 6.0 `rehydrate` não revalida | `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, inbox/outbox | UT-W07, rehydrate do ledger e da transação | ✅ |
| **6.1** `Money` imutável | `src/shared/domain/money.ts` | UT-M06 | ✅ |
| 6.1 String decimal, escala fixa 2 | idem (forma canônica estrita, D-06) | UT-M01, UT-M02 | ✅ ⚠️ |
| 6.1 Moedas diferentes → erro de domínio | `CurrencyMismatchError` | UT-M05 | ✅ |
| 6.1 Rejeita NaN, Infinity, notação científica, vazio, > 2 casas, negativos | `AMOUNT_PATTERN` | UT-M03 | ✅ |
| 6.1 Domínio sem tipos do ORM nem decorators do Nest | — | teste de arquitetura | ✅ |
| 6.1 Persistência exata reidratada como `Money` | custom type MikroORM | IT (I2) | 🟡 I2 |
| 6.1 Modelo multi-moeda com conflitos testados | `Money`, `Wallet` | UT-M05, UT-M09, UT-W06 | ✅ |
| **6.2** No máximo uma wallet por `playerId + currency` | `UNIQUE (player_id, currency)` | IT-04 | 🟡 I2 |
| 6.2 Saldo nunca negativo | `Wallet.debit` ✅; `CHECK (balance >= 0)` | UT-W04, UT-W05 ✅; IT-02 | ✅ · 🟡 I2 |
| 6.2 Toda alteração de saldo tem lançamento (e vice-versa) | `debit/credit` devolvem o lançamento ✅; constraint trigger diferido | UT-W03, "sequência do ledger" ✅ | ✅ · 🟡 I2 |
| 6.2 Sem lost update | lock pessimista | CT-02 | 🟡 I3 |
| 6.2 Moeda da operação = moeda da wallet | `assertSameCurrency` | UT-W06 | ✅ |
| 6.2 `version` inicia em 1 e só sobe quando o saldo muda | `Wallet` | UT-W01..W04 | ✅ |
| **6.3** Estado encapsulado, transições explícitas | `src/modules/wagering/domain/wager-transaction.ts` (`TRANSITIONS`) | UT-T04 | ✅ |
| 6.3 `create` nasce `PENDING` e valida referência por kind | idem | UT-T01, UT-T02 | ✅ |
| 6.3 Terminal → `InvalidTransactionStateError` (erro de programação) | idem | UT-T05 | ✅ |
| 6.3 Transições válidas definidas e documentadas | docs/05 §5 + `TRANSITIONS` | UT-T04, UT-T05 | ✅ |
| 6.3 `OPENING` não entra por API/fila | `create()` recusa; `createOpening()` interno | UT-T03 | ✅ |
| 6.3 Mesma key com payload diferente = conflito | `matchesPayload` ✅; use case | UT-T08 ✅; IT-10, IT-27 | ✅ · 🟡 I3 |
| **6.4** Lançamento sem campos mutáveis nem transições | `wallet-ledger-entry.ts` (congelado) | UT-L02 | ✅ |
| 6.4 `create` valida a aritmética | idem | UT-L01 | ✅ |
| 6.4 No máximo um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` | IT (I2) | 🟡 I2 |
| 6.4 `LOSS` e `REJECTED` não geram lançamento | `ledgerDirectionFor(LOSS)` lança | UT-T07 ✅; IT-11 | ✅ · 🟡 I3 |
| 6.4 Double-entry | — | — | ➖ diferencial (Could) |
| **6.5** `InboxMessage` e `OutboxMessage` | `src/modules/messaging/domain/` | `messaging.spec.ts` | ✅ |
| 6.5 Inbox, financeiro, ledger e outbox na mesma transação SQL | use case | IT-07 | 🟡 I3–I5 |

## §7 Regras de negócio

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| `BET`: débito, rejeita sem saldo | `Wallet.debit`, `ledgerDirectionFor` | UT-W04, UT-T07 | ✅ · 🟡 I3 |
| `WIN`: crédito, pode referenciar `BET` da rodada | `ReferencePolicy` | UT-T07, UT-T10, UT-T12 | ✅ · 🟡 I3 |
| `LOSS`: sem efeito no saldo nem ledger | `affectsBalance()` | UT-T06, UT-T07 | ✅ · 🟡 I3 |
| `REFUND`: crédito, só sobre `BET PROCESSED`, uma vez | `ReferencePolicy` | UT-T10, UT-T13, UT-T14, UT-T16 | ✅ · 🟡 I3 |
| `ROLLBACK`: inverso da referência, uma vez | `ledgerDirectionFor`, `ReferencePolicy` | UT-T07, UT-T16, UT-T17 | ✅ · 🟡 I3 |
| Regra 1: `REFUND`/`ROLLBACK` exigem referência | `ReferenceRequiredError` + `CHECK` no schema | UT-T02 | ✅ · 🟡 I2 |
| Regra 2: mesmo provider, player, wallet, moeda, rodada | `sameContext` | UT-T11 (5 casos) | ✅ |
| Regra 3: `REFUND` → `BET`; `ROLLBACK` → `BET`/`WIN`/`REFUND` | `ALLOWED_REFERENCE_KINDS` | UT-T10 | ✅ |
| Regra 4: reversão única | `existingReversal` + índice parcial único | UT-T13/T17 ✅; IT-06, CT-10 | ✅ ⚠️ D-01 · 🟡 I2 |
| Regra 5: valor igual ao da referência | `AMOUNT_MISMATCH` | UT-T12 | ✅ |
| Regra 6: `REJECTED` não altera saldo nem ledger | use case | IT-11 | 🟡 I3 |
| Regra 7: replay devolve o resultado original com o saldo da época | snapshot `balanceAfter` | UT-T04 ✅; IT-09, IT-11 | ✅ · 🟡 I3 |
| Regra 8: referência ausente → `PENDING_REFERENCE` | `ReferencePolicy` → `WAIT` | UT-T15 ✅; CT-07 | ✅ · 🟡 I5 |
| Regra 9: reversão negativa → código distinto, auditável | `ReversalInsufficientFundsError` + auditoria | UT-W08 ✅; IT-23 | ✅ · 🟡 I3 |
| **7.1** Worker agendado com backoff exponencial | `ReferenceRetryPolicy` ✅; worker com `SKIP LOCKED` | UT-R01, UT-R02, UT-R04 ✅; CT-07 | ✅ política · 🟡 I5 |
| 7.1 Limite de tentativas ou TTL definido e justificado | 10 tentativas / TTL 15 min (ADR-12, docs/03 §9) | UT-R02, UT-R03 | ✅ |
| 7.1 Esgotado → `REJECTED` com código da referência inexistente + evento | `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` | UT-R05 ✅; IT no worker | ✅ domínio · 🟡 I5 |
| **7.2** `failureCode` estável, taxonomia documentada | `FailureCode` + docs/01 §7 (com ação recomendada) | — | ✅ |
| Interpretações adicionais documentadas | docs/01 §6 (D-01..D-20) | — | ✅ |

## §8 Concorrência e ordenação

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Unidade de concorrência = `walletId` | ADR-03 | — | ✅ |
| Duas apostas disputando o saldo | lock + `CHECK` | CT-02, CT-12 | 🟡 I3, I6 |
| Múltiplos workers na mesma wallet | idem | CT-09 | 🟡 I6 |
| Wallets diferentes em paralelo | lock por linha | CT-03 | 🟡 I3 |
| 3+ instâncias simultâneas | Compose ✅; `Bun.spawn` | CT-04 | 🟡 I6 |
| Estratégia justificada | ADR-03, docs/03 §6 | — | ✅ |
| Broker como otimização, banco como garantia | D-08, ADR-10 | IT-12 | ✅ desenho |
| **Cenário obrigatório** 100.00 × 2 `BET 80.00` | — | CT-02 | 🟡 I3 |

## §9 API HTTP

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| `POST /wallets` com `OPENING` + `CREDIT` na mesma transação | E2-2 (inclui eventos na outbox) | IT-08 | 🟡 I2 |
| Wallet duplicada → conflito | `WALLET_ALREADY_EXISTS` → 409 | IT (E2-2) | 🟡 I2 |
| `GET /wallets/:id` | E2-3 | IT | 🟡 I2 |
| `GET /wallets/:id/ledger` com cursor estável e opaco | cursor = `walletVersion` em base64url (ADR-15) | IT-19 | 🟡 I2 |
| `GET /wagering/transactions/:id` e por provedor + id externo | E3-6 | IT | 🟡 I3 |
| `POST /wagering/transactions` | E3-3 | IT-09..11 | 🟡 I3 |
| `Idempotency-Key` obrigatório e fonte da verdade | D-04 | IT | 🟡 I3 |
| Default `{providerId}:{externalTransactionId}` | docs/01 D-04 | — | ✅ doc |
| `payloadHash` = hash de JSON canônico do subconjunto de negócio, algoritmo documentado | `payload-hash.ts` (SHA-256, chaves ordenadas) | UT-T09 | ✅ |
| Requisição idêntica → mesma resposta, `idempotentReplay: true` | snapshot + use case | IT-09 | 🟡 I3 |
| Mesma key, payload diferente → conflito, não replay | use case | IT-10, IT-27 | 🟡 I3 |
| Status HTTP distintos e consistentes (5 situações) | docs/01 §8 + filtro global | IT (I3) | ✅ doc · 🟡 I3 |
| Reconciliação com o formato pedido | E2-4 | IT-20 | 🟡 I2 |
| Divergência: log + métrica + sinalização, sem correção silenciosa | E2-4 | IT-20 | 🟡 I2 |
| `GET /health/live` e `/health/ready` (Postgres + SQS) | `health.module.ts` | IT-21 | ✅ |

## §10 Processamento por SQS

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` | `queues.ts` | `bootstrap.spec.ts` | ✅ |
| Formato da mensagem (`messageId`, `type`, `occurredAt`, `data` com `idempotencyKey`) | schema zod do consumidor | IT-14 | 🟡 I5 |
| Mesmo use case da entrada HTTP | `ProcessWagerTransaction` | IT-12 | 🟡 I5 |
| Inbox persistente por `(consumerName, messageId)` | `InboxMessage` ✅; PK no banco | IT-12 | ✅ · 🟡 I5 |
| `ack` só após o commit | consumidor | CT-05 | 🟡 I5 |
| Distinguir negócio / transitório / permanente | docs/03 §8 e §9.1 | IT-13, IT-14 | ✅ doc · 🟡 I5 |
| Limite de tentativas antes da DLQ | redrive `maxReceiveCount = 5` | `bootstrap.spec.ts` ✅; IT-15 | ✅ · 🟡 I5 |
| `SIGTERM`: concluir ou devolver visibilidade | `enableShutdownHooks` ✅ (I0); drenagem | CT-11 | ✅ base · 🟡 I5 |
| Redelivery sem duplicar efeitos | inbox + idempotência | CT-05 | 🟡 I5 |

## §11 Transactional Outbox

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Atomicidade transação + saldo + ledger + inbox + evento | use case | IT-07 | 🟡 I3 |
| Worker com múltiplos publishers, sem perder nem duplicar indefinidamente | claim com lease + `SKIP LOCKED` (ADR-09); retry sem limite (docs/03 §9.1) | IT-16, CT-06 | 🟡 I4 |
| Commit → processo morre → outra instância publica → duplicata segura | idem | CT-05, CT-06 | 🟡 I4 |
| `WagerTransactionProcessed` (inclusive `LOSS` e `OPENING`) | evento ✅ | `messaging.spec.ts` ✅; IT-08 | ✅ · 🟡 I2/I3 |
| `WagerTransactionRejected` | evento ✅ | `messaging.spec.ts`, UT-R05 | ✅ · 🟡 I3 |
| `WalletBalanceChanged` **somente** quando o saldo muda | evento ✅; use case | UT-E01 ✅; IT | ✅ · 🟡 I3 |
| `WagerTransactionPendingReference` | evento ✅ | `messaging.spec.ts` | ✅ · 🟡 I5 |
| Envelope em classe abstrata, uma subclasse por evento | `integration-event.ts` | UT-E01 | ✅ |
| `eventType` e `version` no tipo | subclasses | UT-E01 | ✅ |
| `data` com `MoneyProps`, JSON estável | subclasses | UT-E01 (ida e volta JSON) | ✅ |

## §12 Observabilidade

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Logs JSON com `correlationId` | pino + `AsyncLocalStorage` | IT (correlação) ✅ | ✅ |
| … com `messageId`, `transactionId`, `walletId`, `providerId` | `enrichContext` ✅ (I0); uso no use case e consumidor | — | 🟡 I3, I5 |
| Sem dados sensíveis nem payload financeiro completo | `REDACT_PATHS` | E7-3 | ✅ · 🟡 teste I6 |
| Métricas: transações por status, duplicatas, conflitos de lock, latência | `/metrics` | IT (I3) | 🟡 I3 |
| Métricas: outbox lag | idem | IT (I4) | 🟡 I4 |
| Métricas: retries, mensagens em DLQ | idem | IT (I5) | 🟡 I5 |
| Health live e ready separados | `health.module.ts` | IT-21 | ✅ |
| OpenTelemetry, dashboard | docs/06 | — | ➖ I8 |

## §13 Testes obrigatórios

| Requisito | Testes | Situação |
|---|---|---|
| **Unidade:** `Money` (escala, arredondamento, entradas inválidas) | UT-M01..M09 (não há arredondamento: > 2 casas é recusado) | ✅ |
| Unidade: invariantes da `Wallet` | UT-W01..W08 + sequência do ledger | ✅ |
| Unidade: regras `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK` | UT-T01..T17, UT-R01..R06 | ✅ |
| Unidade: conflito de moeda | UT-M05, UT-W06 | ✅ |
| Unidade: idempotency key com payload divergente | UT-T08, UT-T09 | ✅ |
| **Integração:** migrations e constraints | IT-01 ✅; IT-02..06 | ✅ · 🟡 I2 |
| Integração: atomicidade wallet/ledger/inbox/outbox | IT-07 | 🟡 I3 |
| Integração: inbox e redelivery | IT-12 | 🟡 I5 |
| Integração: publishers concorrentes | IT-16 | 🟡 I4 |
| Integração: retry e DLQ | IT-13..15 | 🟡 I5 |
| Integração: recuperação após reinício | IT-18 | 🟡 I4 |
| **Concorrência 1:** mesma aposta 50× em paralelo | CT-01 | 🟡 I3 |
| Concorrência 2: saldo disputado | CT-02, CT-12 | 🟡 I3, I6 |
| Concorrência 3: wallets distintas | CT-03 | 🟡 I3 |
| Concorrência 4: ≥ 3 instâncias | CT-04 | 🟡 I6 |
| Concorrência 5: morto após commit e antes do ack | CT-05 | 🟡 I6 |
| Concorrência 6: dois publishers | CT-06 | 🟡 I6 |
| Concorrência 7: `ROLLBACK`/`REFUND` antes da referência | CT-07 | 🟡 I6 |
| Concorrência 8: reinício com consistência final | CT-08 | 🟡 I6 |
| Invariante final `wallet.balance == ledger` em todos os testes | helper `assertLedgerConsistency` | 🟡 I2 em diante |
| Postgres e SQS reais (sem mocks completos) | Testcontainers | ✅ |

## §14 Avaliação

| Item | Situação |
|---|---|
| `README.md` com setup e comandos | ✅ (atualizado a cada iteração) |
| `ARCHITECTURE.md` com decisões, trade-offs e limitações | ✅ 25 ADRs, adaptações, escalabilidade, limitações |
| Teste de carga `bun run test:load` com relatório | ➖ I8 (ST-01..08 planejados) |

**Falhas eliminatórias — onde cada uma é barrada:**

| Falha | Barreira |
|---|---|
| `number` para dinheiro | `Money` com `bigint` + teste de arquitetura ✅ |
| Saldo negativo por race | lock por wallet + `CHECK (balance >= 0)` (I2/I3) + CT-02, CT-12 |
| Débito ou crédito duplicado | `UNIQUE` de idempotência + inbox + índice de reversão única (I2/I3) + CT-01, CT-10 |
| Idempotência só em memória | não existe cache; tudo no banco |
| Correta só com uma instância | Compose com 3 réplicas desde a I0 + CT-04 |
| Evento antes do commit | outbox (I4) + CT-05 |
| Ledger sem auditoria | ledger imutável + trilha `wager_transaction_audit` (I3) |
| Testes só com mocks | Testcontainers com Postgres e LocalStack reais desde a I0 ✅ |
