# 07 — Conformidade com o enunciado

> Matriz **item do enunciado → onde é atendido → teste que prova → situação**. Revisada ao fim de cada iteração; um item só vira ✅ com teste passando.
>
> Legenda: ✅ feito e testado · 🟡 planejado (iteração) · ⚠️ interpretação documentada · ➖ opcional, fora do obrigatório

**Última revisão:** fim da Iteração 6 — 214 testes de unidade, 97 de integração e 5 multi-processo (processos reais com `Bun.spawn`, `SIGKILL`/`SIGTERM` de verdade; estáveis em 5 rodadas seguidas). **Todo o obrigatório (§1–§13) está ✅.**

## Resumo

| § | Tema | Situação |
|---|---|---|
| 1 | Visão geral | ✅ |
| 2 | Autenticação | ✅ decisão + ponto de extensão; mensagens da fila passam pelas mesmas validações de domínio |
| 3 | Contexto do domínio (at-least-once) | ✅ |
| 4 | Stack | ✅ |
| 5 | Restrições invioláveis | ✅ todas as 9 |
| 6 | Modelo de domínio | ✅ |
| 7 | Regras de negócio, referências, failure codes | ✅ |
| 8 | Concorrência | ✅ |
| 9 | API HTTP | ✅ |
| 10 | SQS | ✅ |
| 11 | Outbox e eventos | ✅ |
| 12 | Observabilidade | ✅ logs JSON com correlationId/messageId/transactionId/walletId/providerId, health e todas as métricas exigidas |
| 13 | Testes obrigatórios | ✅ |
| 14 | Avaliação / documentação | ✅ README, ARCHITECTURE em dia |

## §1 Visão geral

| Foco da avaliação | Onde | Situação |
|---|---|---|
| Correção financeira | `Money`, `Wallet`, ledger, schema com cadeia e consistência no commit, reconciliação | ✅ |
| Concorrência entre múltiplas instâncias | lock por wallet (ADR-03); CT-04 com 3 processos reais | ✅ |
| Idempotência persistente | `UNIQUE` + snapshot de saldo + replay/conflito sob o lock da wallet | ✅ |
| Consistência saldo × ledger | `Wallet` devolve o lançamento; cadeia e consistência verificadas no banco (triggers) | ✅ |
| Processamento assíncrono e recuperação | outbox com lease, consumidor com inbox, backoff e DLQ, worker de pendências | ✅ |
| Clareza das decisões | ARCHITECTURE.md (30 ADRs), docs/01 §6 (20 decisões) | ✅ |

## §2 Autenticação

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Não implementar → documentar decisão e desenho | ADR-16 | — | ✅ |
| Ponto de extensão explícito no código | `AuthGuard` no-op + `ProviderIdentityPort` (`src/modules/auth/auth.module.ts`) | — | ✅ |
| Nada de tabela própria de usuários/senhas | não existe | — | ✅ |
| Health sem autenticação | `@Public()` no `HealthController` | IT-21 (`bootstrap.spec.ts`) | ✅ |
| Identidade do provedor na mensagem passa pelas validações de domínio | `executeFromQueue` usa o mesmo núcleo da API | `consumer.spec.ts` (wallet inexistente, rejeições) | ✅ |

## §3 Contexto do domínio

| Premissa | Teste que a cobre | Situação |
|---|---|---|
| Mesma operação várias vezes | CT-01, IT-09 (HTTP) ✅; IT-12 (fila: inbox + replay) ✅ | ✅ |
| Dependente antes da referência | UT-T15, UT-R01..R05, CT-07, cadeia D-15 | ✅ |
| Várias instâncias na mesma wallet | CT-02, CT-12 (1 instância); CT-04/CT-09 (3 processos, HTTP + SQS + duplicatas) | ✅ |
| Processo morre antes/depois do commit | IT-07 (antes); CT-05 (`SIGKILL` real após commit, antes do ack); CT-08 (todas as instâncias com `SIGKILL` sob carga) | ✅ |
| Eventos publicados mais de uma vez | `outbox.spec.ts` (crash após publicar: republicação com o mesmo `eventId`) | ✅ |
| Postgres e SQS indisponíveis | IT-21, IT-17 ✅; IT-13 (transitório no consumidor → backoff) ✅ | ✅ |
| **Invariantes:** sem crédito/débito duplicado, sem perder evento, sem saldo negativo | CT-01, CT-02, CT-10, CT-12, IT-02, IT-06, IT-16, crash da outbox | ✅ |

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
| Justificar ORM, mapeamento do `Money` e estratégia transacional | ADR-01, ADR-02, ADR-03, ADR-04; `Money` em `NUMERIC(20,2)` + `char(3)`, lido como string e reidratado pelos mappers | ✅ |

## §5 Restrições invioláveis

| # | Restrição | Onde é garantida | Teste | Situação |
|---|---|---|---|---|
| 1 | Sem `number`/`float` para dinheiro | `Money` com `bigint`; `NUMERIC(20,2)` | teste de arquitetura (proíbe `parseFloat`, `Number(`, `toFixed`…) | ✅ |
| 2 | Idempotência não em memória | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`; inbox na I5 | IT-09, IT-10, IT-27, CT-01 | ✅ |
| 3 | Não confiar só no FIFO | banco é a garantia final (D-08, ADR-10) | CT-01, CT-02 sem fila envolvida | ✅ |
| 4 | Evento só após commit | outbox gravada na transação; publisher lê só o que foi commitado (ADR-09) | IT-07, IT-18, `outbox.spec.ts` | ✅ |
| 5 | Ledger sem sobrescrita/exclusão | `WalletLedgerEntry` congelado; triggers recusam `UPDATE`, `DELETE` e `TRUNCATE` | UT-L02, IT-03 | ✅ |
| 6 | Sem lock global | lock por linha de wallet (ADR-03) | CT-03 | ✅ |
| 7 | Sem `read → calculate → update` sem controle | `SELECT … FOR UPDATE` + `CHECK` + trigger de consistência | CT-02, CT-12 | ✅ |
| 8 | Correta com múltiplas instâncias | 3 processos reais | CT-04, CT-08 | ✅ |
| 9 | Garantias no **schema** | `CHECK`, `UNIQUE`, índice parcial, cadeia do ledger e consistência no commit (migration `wallet_ledger_schema`) | IT-02..06 + 8 casos em `schema.spec.ts` | ✅ |

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
| 6.1 Persistência exata reidratada como `Money` | `decimal` em modo string + mappers (`Money.from`) | IT-08, IT-19, IT-20 | ✅ |
| 6.1 Modelo multi-moeda com conflitos testados | `Money`, `Wallet` | UT-M05, UT-M09, UT-W06 | ✅ |
| **6.2** No máximo uma wallet por `playerId + currency` | `UNIQUE (player_id, currency)` → `409 WALLET_ALREADY_EXISTS` | IT-04; 10 criações simultâneas → 1 vence | ✅ |
| 6.2 Saldo nunca negativo | `Wallet.debit` + `CHECK (balance >= 0)` | UT-W04, UT-W05, IT-02 | ✅ |
| 6.2 Toda alteração de saldo tem lançamento (e vice-versa) | `debit/credit` devolvem o lançamento; constraint trigger diferido `trg_wallet_matches_ledger` | UT-W03; "consistência no commit" (2 casos) | ✅ |
| 6.2 Sem lost update | lock pessimista | CT-02, CT-12 | ✅ |
| 6.2 Moeda da operação = moeda da wallet | `assertSameCurrency` | UT-W06 | ✅ |
| 6.2 `version` inicia em 1 e só sobe quando o saldo muda | `Wallet` | UT-W01..W04 | ✅ |
| **6.3** Estado encapsulado, transições explícitas | `src/modules/wagering/domain/wager-transaction.ts` (`TRANSITIONS`) | UT-T04 | ✅ |
| 6.3 `create` nasce `PENDING` e valida referência por kind | idem | UT-T01, UT-T02 | ✅ |
| 6.3 Terminal → `InvalidTransactionStateError` (erro de programação) | idem | UT-T05 | ✅ |
| 6.3 Transições válidas definidas e documentadas | docs/05 §5 + `TRANSITIONS` | UT-T04, UT-T05 | ✅ |
| 6.3 `OPENING` não entra por API/fila | `create()` recusa; `createOpening()` interno | UT-T03 | ✅ |
| 6.3 Mesma key com payload diferente = conflito | `matchesPayload` + use case | UT-T08, IT-10, IT-27 | ✅ |
| **6.4** Lançamento sem campos mutáveis nem transições | `wallet-ledger-entry.ts` (congelado) | UT-L02 | ✅ |
| 6.4 `create` valida a aritmética | idem | UT-L01 | ✅ |
| 6.4 No máximo um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` | `schema.spec.ts` | ✅ |
| 6.4 `LOSS` e `REJECTED` não geram lançamento | `affectsBalance()` + `WagerProcessor` | UT-T07, `transactions.spec.ts` | ✅ |
| 6.4 Double-entry | — | — | ➖ diferencial (Could) |
| **6.5** `InboxMessage` e `OutboxMessage` | `src/modules/messaging/domain/` | `messaging.spec.ts` | ✅ |
| 6.5 Inbox, financeiro, ledger e outbox na mesma transação SQL | `UnitOfWork` + `inbox.register` no mesmo scope | IT-07, CT-05 | ✅ |

## §7 Regras de negócio

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| `BET`: débito, rejeita sem saldo | `Wallet.debit`, `WagerProcessor` | UT-W04, `transactions.spec.ts` | ✅ |
| `WIN`: crédito, pode referenciar `BET` da rodada | `ReferencePolicy` | UT-T07, UT-T10, UT-T12, `transactions.spec.ts` | ✅ |
| `LOSS`: sem efeito no saldo nem ledger | `affectsBalance()` | UT-T06, `transactions.spec.ts` (sem lançamento, sem `WalletBalanceChanged`, versão inalterada) | ✅ |
| `REFUND`: crédito, só sobre `BET PROCESSED`, uma vez | `ReferencePolicy` | UT-T10..T16, `transactions.spec.ts`, CT-10 | ✅ |
| `ROLLBACK`: inverso da referência, uma vez | `ledgerDirectionFor`, `ReferencePolicy` | UT-T07, UT-T17, CT-10 | ✅ |
| Regra 1: `REFUND`/`ROLLBACK` exigem referência | `ReferenceRequiredError` + `ck_tx_reference_required` | UT-T02, `schema.spec.ts` | ✅ |
| Regra 2: mesmo provider, player, wallet, moeda, rodada | `sameContext` | UT-T11 (5 casos) | ✅ |
| Regra 3: `REFUND` → `BET`; `ROLLBACK` → `BET`/`WIN`/`REFUND` | `ALLOWED_REFERENCE_KINDS` | UT-T10 | ✅ |
| Regra 4: reversão única | `existingReversal` + índice parcial `uq_tx_single_reversal` | UT-T13/T17, IT-06, CT-10 (10×) | ✅ ⚠️ D-01 |
| Regra 5: valor igual ao da referência | `AMOUNT_MISMATCH` | UT-T12 | ✅ |
| Regra 6: `REJECTED` não altera saldo nem ledger | `WagerProcessor.reject` | `transactions.spec.ts` | ✅ |
| Regra 7: replay devolve o resultado original com o saldo da época | snapshot `balanceAfter` | IT-09, IT-11 | ✅ |
| Regra 8: referência ausente → `PENDING_REFERENCE` | `ReferencePolicy` → `WAIT`; worker resolve | UT-T15, CT-07, cadeia D-15 | ✅ |
| Regra 9: reversão negativa → código distinto, auditável | `ReversalInsufficientFundsError` + auditoria `REJECTED` | UT-W08, `transactions.spec.ts` | ✅ |
| **7.1** Worker agendado com backoff exponencial | `ResolvePendingReferencesUseCase` + `PendingReferenceWorker` (claim com lease e `SKIP LOCKED`) | UT-R01..R04, `pending-references.spec.ts` (2 workers concorrentes) | ✅ |
| 7.1 Limite de tentativas ou TTL definido e justificado | 10 tentativas / TTL 15 min (ADR-12, docs/03 §9) | UT-R02, UT-R03 | ✅ |
| 7.1 Esgotado → `REJECTED` com código da referência inexistente + evento | `WagerProcessor.expire` | UT-R05, `pending-references.spec.ts` (RETRY_SCHEDULED ×2 → REJECTED + evento) | ✅ |
| **7.2** `failureCode` estável, taxonomia documentada | `FailureCode` + docs/01 §7 (com ação recomendada) | — | ✅ |
| Interpretações adicionais documentadas | docs/01 §6 (D-01..D-20) | — | ✅ |

## §8 Concorrência e ordenação

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Unidade de concorrência = `walletId` | ADR-03 | — | ✅ |
| Duas apostas disputando o saldo | lock + `CHECK` | CT-02 (10×), CT-12 | ✅ |
| Múltiplos workers na mesma wallet | lock + `CHECK` | CT-04/CT-09 (HTTP e consumidores de 3 processos na mesma wallet) | ✅ |
| Wallets diferentes em paralelo | lock por linha | CT-03 | ✅ |
| 3+ instâncias simultâneas | `Bun.spawn` de 3 processos | CT-04, CT-08 | ✅ |
| Estratégia justificada | ADR-03, docs/03 §6 | — | ✅ |
| Broker como otimização, banco como garantia | D-08, ADR-10 | IT-12 | ✅ desenho |
| **Cenário obrigatório** 100.00 × 2 `BET 80.00` | — | CT-02 (repetido 10×) | ✅ |

## §9 API HTTP

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| `POST /wallets` com `OPENING` + `CREDIT` na mesma transação | `CreateWalletUseCase` (inclui eventos na outbox) | IT-08 | ✅ |
| Wallet duplicada → conflito | `WALLET_ALREADY_EXISTS` → 409 | `wallets.spec.ts` | ✅ |
| `GET /wallets/:id` | `GetWalletUseCase` | `wallets.spec.ts` (200, 404, 400) | ✅ |
| `GET /wallets/:id/ledger` com cursor estável e opaco | cursor = `walletVersion` em base64url (ADR-15) | IT-19 (inserção entre páginas não desloca) | ✅ |
| `GET /wagering/transactions/:id` e por provedor + id externo | `GetTransactionUseCase` | `transactions.spec.ts` | ✅ |
| `POST /wagering/transactions` | `ProcessWagerTransactionUseCase` | `transactions.spec.ts` | ✅ |
| `Idempotency-Key` obrigatório e fonte da verdade | D-04 | header ausente → 400; chave divergente → 409 | ✅ |
| Default `{providerId}:{externalTransactionId}` | docs/01 D-04 | — | ✅ doc |
| `payloadHash` = hash de JSON canônico do subconjunto de negócio, algoritmo documentado | `payload-hash.ts` (SHA-256, chaves ordenadas) | UT-T09 | ✅ |
| Requisição idêntica → mesma resposta, `idempotentReplay: true` | snapshot + use case | IT-09, CT-01 | ✅ |
| Mesma key, payload diferente → conflito, não replay | use case | IT-10, IT-27 | ✅ |
| Status HTTP distintos e consistentes (5 situações) | docs/01 §8 + `ProblemDetailsFilter` (RFC 9457) | 201/200/202/400/404/409/422 testados; 503 pela tradução de erros transitórios | ✅ |
| Reconciliação com o formato pedido | `ReconcileWalletUseCase` (snapshot `REPEATABLE READ`) | IT-20 | ✅ |
| Divergência: log + métrica + sinalização, sem correção silenciosa | log `warn` + `wagering_reconciliation_divergence_total` + `consistent: false` | IT-20 (saldo permanece alterado) | ✅ |
| `GET /health/live` e `/health/ready` (Postgres + SQS) | `health.module.ts` | IT-21 | ✅ |

## §10 Processamento por SQS

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` | `queues.ts` | `bootstrap.spec.ts` | ✅ |
| Formato da mensagem (`messageId`, `type`, `occurredAt`, `data` com `idempotencyKey`) | `WagerTransactionRequestedMessage` (zod, contrato compartilhado com a API) | IT-14 | ✅ |
| Mesmo use case da entrada HTTP | `ProcessWagerTransactionUseCase.executeFromQueue` | `consumer.spec.ts` | ✅ |
| Inbox persistente por `(consumerName, messageId)` | `inbox_messages` (PK) + `INSERT … ON CONFLICT DO NOTHING` na transação | IT-12, CT-05 | ✅ |
| `ack` só após o commit | `DeleteMessage` depois do `executeFromQueue` | CT-05 | ✅ |
| Distinguir negócio / transitório / permanente | consumidor: negócio → ack; transitório → `ChangeMessageVisibility` com backoff; permanente → DLQ | `consumer.spec.ts` (IT-13, IT-14, rejeições) | ✅ |
| Limite de tentativas antes da DLQ | redrive `maxReceiveCount` | `bootstrap.spec.ts`, IT-15 | ✅ |
| `SIGTERM`: concluir ou devolver visibilidade | long polling abortado; em andamento concluem; não iniciadas voltam (`VisibilityTimeout 0`) | CT-11 + `SIGTERM` real em processo (drenagem registrada, < 10 s) | ✅ |
| Redelivery sem duplicar efeitos | inbox + idempotência | IT-12, CT-05, Compose (30 duplicatas, 0 efeitos extras) | ✅ |

## §11 Transactional Outbox

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Atomicidade transação + saldo + ledger + inbox + evento | `UnitOfWork` (inbox no mesmo scope) | IT-07 (HTTP) e IT-07 fila (falha antes do commit desfaz também a inbox); CT-05 (commit inclui a inbox) | ✅ |
| Worker com múltiplos publishers, sem perder nem duplicar indefinidamente | claim com lease + `SKIP LOCKED`; retry sem limite; marca só se o lease é seu | IT-16 (2 publishers, 60 eventos, 0 duplicatas) + Compose (3 réplicas, 40/40 únicos) | ✅ |
| Commit → processo morre → outra instância publica → duplicata segura | lease expira; `MessageDeduplicationId = eventId` | `outbox.spec.ts` + CT-06 (`SIGKILL` real do publisher, 2 sobreviventes, 40/40 eventos) | ✅ |
| `WagerTransactionProcessed` (inclusive `LOSS` e `OPENING`) | evento + use cases | `messaging.spec.ts`, IT-08, `transactions.spec.ts` (LOSS) | ✅ |
| `WagerTransactionRejected` | evento + `WagerProcessor` | `transactions.spec.ts` | ✅ |
| `WalletBalanceChanged` **somente** quando o saldo muda | `WagerProcessor` | UT-E01, `transactions.spec.ts` (LOSS e REJECTED sem o evento) | ✅ |
| `WagerTransactionPendingReference` | evento + `WagerProcessor` | `transactions.spec.ts` | ✅ |
| Envelope em classe abstrata, uma subclasse por evento | `integration-event.ts` | UT-E01 | ✅ |
| `eventType` e `version` no tipo | subclasses | UT-E01 | ✅ |
| `data` com `MoneyProps`, JSON estável | subclasses | UT-E01 (ida e volta JSON) | ✅ |

## §12 Observabilidade

| Requisito | Onde | Teste | Situação |
|---|---|---|---|
| Logs JSON com `correlationId` | pino + `AsyncLocalStorage` | IT (correlação) ✅ | ✅ |
| … com `messageId`, `transactionId`, `walletId`, `providerId` | `runWithContext` + `enrichContext` no consumidor; auditoria grava todos | `consumer.spec.ts` | ✅ |
| Sem dados sensíveis nem payload financeiro completo | `REDACT_PATHS` | `logger.spec.ts` (valores, payloads, credenciais mascarados; ids visíveis) | ✅ |
| Métricas: transações por status, duplicatas, conflitos de lock, latência | `wagering_transactions_total`, `wagering_duplicates_detected_total`, `wagering_lock_wait_seconds`, `wagering_lock_conflicts_total`, `wagering_lock_timeouts_total`, `wagering_processing_duration_seconds`, `wagering_errors_total` | `transactions.spec.ts` | ✅ |
| Métricas: outbox lag | `wagering_outbox_lag_seconds`, `wagering_outbox_published_total`, `wagering_retries_total{component="outbox"}` | `outbox.spec.ts` | ✅ |
| Métricas: retries, mensagens em DLQ | `wagering_retries_total{component}`, `wagering_dlq_messages_total{reason}`, `wagering_queue_wait_seconds`, `wagering_pending_references` | `consumer.spec.ts`, `outbox.spec.ts` | ✅ |
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
| **Integração:** migrations e constraints | IT-01..06 + `schema.spec.ts` | ✅ |
| Integração: atomicidade wallet/ledger/inbox/outbox | IT-07 (HTTP e fila) | ✅ |
| Integração: inbox e redelivery | IT-12, CT-05 | ✅ |
| Integração: publishers concorrentes | IT-16 | ✅ |
| Integração: retry e DLQ | IT-13, IT-14, IT-15 | ✅ |
| Integração: recuperação após reinício | IT-18 (eventos gravados com o publisher parado são publicados quando ele sobe) | ✅ |
| **Concorrência 1:** mesma aposta 50× em paralelo | CT-01 | ✅ |
| Concorrência 2: saldo disputado | CT-02, CT-12 | ✅ |
| Concorrência 3: wallets distintas | CT-03 | ✅ |
| Concorrência 4: ≥ 3 instâncias | CT-04 (3 processos reais) | ✅ |
| Concorrência 5: morto após commit e antes do ack | CT-05 (`SIGKILL` real no ponto exato) | ✅ |
| Concorrência 6: dois publishers | IT-16 + CT-06 (processos reais, um morto com `SIGKILL`) | ✅ |
| Concorrência 7: `ROLLBACK`/`REFUND` antes da referência | CT-07, cadeia D-15 | ✅ |
| Concorrência 8: reinício com consistência final | CT-08 (3 processos mortos sob carga HTTP + SQS, 3 novos; cada operação 1×, reconciliação consistente) | ✅ |
| Invariante final `wallet.balance == ledger` em todos os testes | helper `assertLedgerConsistency` (soma, cadeia e versões) | ✅ em uso desde a I2 |
| Postgres e SQS reais (sem mocks completos) | Testcontainers | ✅ |

## §14 Avaliação

| Item | Situação |
|---|---|
| `README.md` com setup e comandos | ✅ (atualizado a cada iteração) |
| `ARCHITECTURE.md` com decisões, trade-offs e limitações | ✅ 30 ADRs, adaptações, escalabilidade, limitações |
| Teste de carga `bun run test:load` com relatório | ➖ I8 (ST-01..08 planejados) |

**Falhas eliminatórias — onde cada uma é barrada:**

| Falha | Barreira |
|---|---|
| `number` para dinheiro | `Money` com `bigint` + teste de arquitetura ✅ |
| Saldo negativo por race | lock por wallet + `CHECK (balance >= 0)` + CT-02, CT-12 ✅ |
| Débito ou crédito duplicado | `UNIQUE` de idempotência + inbox + índice de reversão única + CT-01, CT-10, IT-12, CT-05 ✅ |
| Idempotência só em memória | não existe cache; tudo no banco |
| Correta só com uma instância | Compose com 3 réplicas desde a I0 + CT-04 e CT-08 com 3 processos reais ✅ |
| Evento antes do commit | outbox na transação + publisher assíncrono (I4) + IT-07, IT-18 ✅ |
| Ledger sem auditoria | ledger imutável + trilha `wager_transaction_audit` (todo lançamento tem 1 auditoria — IT-25) ✅ |
| Testes só com mocks | Testcontainers com Postgres e LocalStack reais desde a I0 ✅ |
