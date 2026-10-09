# 01 — Análise de Requisitos

> Leitura crítica do enunciado ([CHALLENGE.md](./CHALLENGE.md)). O objetivo é transformar o texto em requisitos verificáveis, apontar ambiguidades e registrar a interpretação adotada **antes** de escrever código.

## 1. O que realmente está sendo avaliado

O enunciado deixa claro: não é CRUD. A nota vem de **correção sob falha e concorrência**.

| Área | Pts | Tradução prática |
|---|---|---|
| Correção financeira | 20 | `Money` exato, ledger que reconstrói o saldo, reversões corretas, reconciliação |
| Concorrência | 20 | zero lost update com 3+ instâncias e hot wallet |
| Idempotência | 15 | dedup no banco, replay fiel, conflito de payload |
| Mensageria e falhas | 15 | inbox, outbox, retry/backoff, DLQ, crash recovery, SIGTERM |
| Modelagem | 10 | invariantes dentro das classes, portas, simplicidade |
| Testes | 10 | Postgres/SQS reais, races reais, determinismo |
| Observabilidade | 5 | logs JSON, métricas, health |
| Documentação | 5 | README + ARCHITECTURE com trade-offs |

**Consequência de priorização:** 70 dos 100 pontos estão em correção, concorrência, idempotência e mensageria. Autenticação vale 0 → fica como ponto de extensão (`AuthGuard` no-op), decisão documentada.

## 2. Requisitos funcionais (RF)

| ID | Requisito | Origem |
|---|---|---|
| RF-01 | Criar wallet com saldo inicial; saldo > 0 gera transação `OPENING` + ledger `CREDIT` na mesma transação SQL | §9 |
| RF-02 | Uma wallet por `playerId + currency`; duplicada → conflito | §6.2, §9 |
| RF-03 | Consultar wallet, ledger paginado (cursor opaco e estável), transação por id interno e por `(providerId, externalTransactionId)` | §9 |
| RF-04 | Submeter `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` via HTTP com `Idempotency-Key` obrigatório | §9 |
| RF-05 | Consumir as mesmas operações via SQS FIFO reutilizando **o mesmo use case** | §10 |
| RF-06 | Referência ausente → `PENDING_REFERENCE`, reprocessada por worker com backoff; esgotado → `REJECTED` + evento | §7.1 |
| RF-07 | Publicar eventos de integração via Transactional Outbox | §11 |
| RF-08 | Reconciliação: saldo armazenado × saldo reconstruído pelo ledger, sem correção silenciosa | §9 |
| RF-09 | Health checks `live` e `ready` (Postgres + SQS), sem autenticação | §9, §12 |
| RF-10 | Toda rejeição carrega `failureCode` estável e legível por máquina | §7.2 |
| RF-11 | Linha do tempo auditável de cada transação (`GET /wagering/transactions/:id/audit`) | §7 regra 9, D-18 |

## 3. Requisitos não funcionais (RNF)

| ID | Requisito | Onde é garantido |
|---|---|---|
| RNF-01 | Dinheiro nunca em `number`/`float` | `Money` com `bigint` em centavos; coluna `NUMERIC(20,2)` |
| RNF-02 | Idempotência persistente (nunca em memória) | `UNIQUE` no banco + inbox |
| RNF-03 | Correto com ≥ 3 instâncias | lock por linha de wallet (`SELECT … FOR UPDATE`) |
| RNF-04 | Sem lock global | lock é por `walletId` |
| RNF-05 | Evento só após commit | outbox na mesma transação + publisher assíncrono |
| RNF-06 | Ledger imutável | trigger que bloqueia `UPDATE/DELETE` + sem métodos de mutação |
| RNF-07 | Invariantes no **schema** | `CHECK`, `UNIQUE`, índices parciais, triggers (ver §5) |
| RNF-08 | Migrations versionadas e reversíveis | MikroORM Migrations com `up/down` |
| RNF-09 | Logs JSON sem dados sensíveis | logger estruturado com redaction |
| RNF-10 | Shutdown gracioso | `enableShutdownHooks` + drenagem do consumidor |

## 4. Invariantes globais (o que nunca pode quebrar)

1. `wallet.balance >= 0` — sempre.
2. `wallet.balance == Σ(CREDIT) − Σ(DEBIT)` do ledger da wallet.
3. Cada transação financeira gera **no máximo um** lançamento por wallet.
4. Uma mesma operação (idempotency key) é aplicada **no máximo uma vez**.
5. Uma referência é revertida **no máximo uma vez** (ver decisão D-01).
6. Todo evento confirmado no banco é publicado **pelo menos uma vez**.
7. Nenhum evento é publicado para algo que não foi commitado.
8. Todo movimento de saldo **e toda decisão** sobre uma transação deixam registro imutável no banco: aplicação, rejeição, pendência, retry, replay e conflito (ver D-18).

## 5. Matriz "regra → onde é imposta"

O item 9 das restrições exige que garantias estejam no banco, não só no código. Defesa em profundidade: o domínio valida primeiro (erro rico), o banco é a última barreira.

| Garantia | Domínio | Banco |
|---|---|---|
| Saldo não negativo | `Wallet.debit()` | `CHECK (balance >= 0)` |
| 1 wallet por player+moeda | — | `UNIQUE (player_id, currency)` |
| Idempotência | `matchesPayload()` | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| 1 lançamento por transação/wallet | `Wallet` retorna 1 entry | `UNIQUE (transaction_id, wallet_id)` |
| Ledger imutável | classe sem setters | trigger `BEFORE UPDATE OR DELETE → RAISE` |
| Aritmética do lançamento | `WalletLedgerEntry.create` | `CHECK (balance_after = balance_before ± amount)` |
| Sequência do ledger sem buracos | `version` | `UNIQUE (wallet_id, wallet_version)` |
| Reversão única | regra de domínio | índice único parcial em `reference_transaction_id` para `REFUND/ROLLBACK` `PROCESSED` |
| Valor positivo | `Money` | `CHECK (amount > 0)` no ledger |
| Status válido | enum TS | `CHECK (status IN (...))` |
| Inbox única | — | `PRIMARY KEY (consumer_name, message_id)` |
| Trilha de auditoria imutável | use case grava 1 registro por decisão | tabela `wager_transaction_audit` append-only (trigger), na mesma transação SQL |
| `OPENING` só interno | validação de entrada | `CHECK` coerente entre `kind` e `provider_id = 'internal'` |

## 6. Ambiguidades e decisões adotadas

Cada decisão vira uma entrada no `ARCHITECTURE.md`.

| # | Ponto ambíguo no enunciado | Decisão | Motivo |
|---|---|---|---|
| D-01 | §7 regra 4: "não pode ser revertida duas vezes **pelo mesmo tipo**". Literalmente permite `REFUND` **e** `ROLLBACK` sobre a mesma `BET` → crédito duplo | Uma transação pode ser revertida **uma única vez, por qualquer tipo**. `REFUND` e `ROLLBACK` são duas portas para **o mesmo fluxo de reversão**; a primeira a chegar vence. A perdedora é `REJECTED REFERENCE_ALREADY_REVERSED`, com a vencedora registrada (`relatedTransactionId`) na resposta e na auditoria | A invariante "não duplicar créditos" prevalece sobre a leitura literal. Esperar para "confirmar que não haverá rollback" foi descartado: não existe sinal de fim de rodada, ambas creditam o mesmo valor sobre uma `BET` e a espera atrasaria todo reembolso. Uma checagem por **usuário + valor numa janela de 1 h** (com resposta "aguarde") também foi descartada: bloqueia devoluções legítimas de apostas diferentes com o mesmo valor, deixa passar duplicatas após a janela, corre risco de corrida sem lock e não é idempotente (a resposta muda com o horário) |
| D-02 | `WIN` "pode referenciar" a `BET` | Referência opcional; se informada, é validada como as demais e pode ficar `PENDING_REFERENCE` | Consistência das regras de referência |
| D-03 | Wallet inexistente no `POST /wagering/transactions` | `404 WALLET_NOT_FOUND`, **não persistido** (não há wallet para FK); na fila é erro de negócio → ack | Não há agregado para auditar; resposta é determinística |
| D-04 | `Idempotency-Key` × `(providerId, externalTransactionId)` | Ambos únicos. Mesmo `(provider, externalId)` com key diferente → `409 IDEMPOTENCY_KEY_MISMATCH` | Evita a mesma operação do provedor entrar duas vezes por keys diferentes |
| D-05 | Replay deve devolver "o saldo observado naquele momento" | Transação guarda `balance_after` (snapshot), inclusive para `LOSS` e `REJECTED` | `LOSS` não tem ledger; não dá para derivar o saldo depois |
| D-06 | Formato de entrada de `amount` | Regex estrita `^\d{1,18}(\.\d{1,2})?$`; normaliza para 2 casas antes do hash | Aceita `"25"`/`"25.5"`, rejeita `1e3`, `-1`, `"25.001"`, `""` |
| D-07 | Valor zero | `amount > 0` para todos os kinds, exceto `LOSS` (aceita `>= 0`) | `BET 0.00` não tem semântica financeira |
| D-08 | Destino dos eventos não é especificado | Fila `wagering-events.fifo`, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId` | Ordem por wallet e dedup de 5 min como otimização |
| D-09 | Quando usar `FAILED` | Transação já persistida cujo reprocessamento esgota tentativas por erro de **infraestrutura** | `REJECTED` = negócio; `FAILED` = infra, terminal e auditável |
| D-10 | `ROLLBACK` de `REFUND`/`WIN` que deixaria saldo negativo | `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`) | Exigido pela regra 9 |
| D-11 | `OPENING` não tem round/game/provider | `provider_id = 'internal'`, `idempotency_key = 'internal:opening:{walletId}'`, `round_id/game_id` nulos só para `OPENING` (`CHECK`) | Mantém a tabela única de transações |
| D-12 | Reconciliação concorrente com escrita | Leitura em transação `REPEATABLE READ READ ONLY` (snapshot único para wallet + ledger) | Evita falso positivo de divergência |
| D-13 | Replay via SQS | Não gera novos eventos na outbox | Evento já foi enfileirado na primeira aplicação |
| D-14 | Mensagem com mesmo `messageId` e payload diferente | Métrica `inbox_payload_mismatch` + DLQ | Anomalia do produtor, precisa de olho humano |
| D-15 | Referência existente mas ainda `PENDING_REFERENCE` | Dependente continua aguardando | Cadeias fora de ordem (ex.: `ROLLBACK` de `REFUND` pendente) |
| D-16 | Referência `REJECTED`/`FAILED` | Dependente → `REJECTED` com `REFERENCE_NOT_PROCESSED` | Não se reverte o que não foi aplicado |
| D-17 | Moeda | Implementação assume `BRL`, mas `Money` é multi-moeda e conflitos são testados | Permitido pelo §6.1 |
| D-18 | "Auditável" aparece no enunciado só para `FAILED` e reversões | **Toda decisão** sobre uma transação é auditada em tabela própria, append-only, gravada na mesma transação SQL da decisão, inclusive replays e conflitos de idempotência. Exposta em `GET /wagering/transactions/:id/audit` | Responder "para onde foi o dinheiro e o que aconteceu" só com SQL, sem depender de logs que expiram |
| D-19 | "Um jogo por vez" por jogador (evitar usar o mesmo saldo em dois aparelhos) | **Não é aplicado neste serviço.** O saldo único sob lock da wallet + `CHECK (balance >= 0)` + sequência de versões do ledger impedem **gastar o saldo simultaneamente mais de uma vez**, em qualquer jogo ou aparelho (CT-12). Apostas paralelas cuja soma cabe no saldo **são permitidas** (decisão confirmada). A sessão única é responsabilidade da plataforma (login / lançamento do jogo). Aqui ficam: um ponto de extensão `PlayerSessionPolicy` (no-op) antes de cada `BET` e um alerta antifraude de jogos simultâneos | o serviço não conhece sessões nem aparelhos; sem sinal confiável de fim de rodada, um bloqueio travaria jogadores quando um `LOSS` se perdesse |
| D-20 | Natureza do `playerId` | **Premissa:** ID opaco emitido pela plataforma, em formato UUID (validado no contrato), **nunca** CPF, e-mail ou telefone. Circula só entre servidores (provedor → API) e dentro do banco; consultas sempre parametrizadas; mascarado em e-mails e ausente de métricas | um vazamento de log ou auditoria não expõe dados pessoais; UUID aleatório não é adivinhável |

## 7. Taxonomia de `failureCode`

Cada código carrega uma **ação recomendada** ao provedor:

| Código | Categoria | Ação do provedor | Persistido? |
|---|---|---|---|
| `VALIDATION_ERROR` | entrada | corrigir payload | não |
| `OPENING_NOT_ALLOWED` | entrada | corrigir payload | não |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | conflito | não reenviar; investigar | não |
| `IDEMPOTENCY_KEY_MISMATCH` | conflito | usar a key original | não |
| `WALLET_NOT_FOUND` | negócio | corrigir payload | não |
| `WALLET_PLAYER_MISMATCH` | negócio | corrigir payload | sim (`REJECTED`) |
| `CURRENCY_MISMATCH` | negócio | corrigir payload | sim |
| `INSUFFICIENT_FUNDS` | negócio | desistir | sim |
| `REVERSAL_INSUFFICIENT_FUNDS` | negócio | escalar operacionalmente | sim |
| `REFERENCE_REQUIRED` | entrada | corrigir payload | não |
| `REFERENCE_NOT_FOUND` | negócio (após TTL) | desistir / conciliar | sim |
| `REFERENCE_MISMATCH` | negócio | corrigir payload | sim |
| `REFERENCE_INVALID_KIND` | negócio | corrigir payload | sim |
| `REFERENCE_NOT_PROCESSED` | negócio | desistir | sim |
| `REFERENCE_ALREADY_REVERSED` | negócio | desistir | sim |
| `AMOUNT_MISMATCH` | negócio | corrigir payload | sim |
| `CONCURRENT_GAME_NOT_ALLOWED` | negócio (**reservado**, inativo; ver D-19) | aguardar o fim do outro jogo | sim |
| `INFRA_UNAVAILABLE` | transitório | reenviar com backoff | não |
| `INFRA_RETRIES_EXHAUSTED` | permanente | escalar | sim (`FAILED`) |

## 8. Mapeamento HTTP

Consistente em **todos** os endpoints (filtro global de exceções):

| Situação | HTTP | Corpo |
|---|---|---|
| Processada (nova) | `201` | `status: PROCESSED`, `idempotentReplay: false` |
| Replay de processada | `200` | mesmo corpo, `idempotentReplay: true` |
| Aceita, aguardando referência | `202` | `status: PENDING_REFERENCE` |
| Rejeitada por negócio (inclui replay) | `422` | `status: REJECTED`, `failureCode` |
| Payload inválido | `400` | `failureCode: VALIDATION_ERROR`, detalhes por campo |
| Recurso inexistente | `404` | `failureCode` |
| Conflito (idempotência, wallet duplicada) | `409` | `failureCode` |
| Falha transitória de infraestrutura | `503` + `Retry-After` | `failureCode: INFRA_UNAVAILABLE` |

Erro padrão (RFC 9457 *problem details*): `{ type, title, status, failureCode, detail, correlationId }`.
