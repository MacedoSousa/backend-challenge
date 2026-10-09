# 08 — Revisão técnica: achados, correções e respostas

Na Iteração 8, um parecer de *tech lead* revisou o código por leitura e apontou 9
divergências entre o enunciado, a documentação e o código. Ele também listou 14 perguntas
para a apresentação. Este documento registra, **conferido contra o código**:
- o que procedia e como foi corrigido, com o teste que prova a correção;
- a resposta a cada pergunta;
- todos os retries do sistema: motivo, quantidade, tempo até desistir e por quê.

Nenhum achado era eliminatório, e o próprio parecer reconheceu:
- dinheiro em `bigint`;
- lock por wallet;
- idempotência persistida;
- atomicidade com outbox;
- garantias no banco (triggers do ledger e consistência no commit);
- testes reais com 3 processos e `SIGKILL`.

---

## 1. Placar

| # | Achado | Procedia? | Situação | Prova |
|---|---|---|---|---|
| 1 | `FAILED` nunca era produzido | sim | ✅ corrigido | `consumer.spec.ts` — "div. 1" |
| 2 | Métrica de DLQ cega ao redrive do SQS | sim | ✅ corrigido | `consumer.spec.ts` — "div. 2"; `metrics.spec.ts` |
| 3 | Erro de programação tratado como transitório | sim | ✅ corrigido | `consumer.spec.ts` — "div. 3" |
| 4 | Ordem FIFO quebrava dentro do lote | sim | ✅ corrigido | `consumer.spec.ts` — "div. 4" |
| 5 | Rejeição pela fila não chegava ao provedor | em parte | ✅ corrigido | `failure-paths.spec.ts`, `consumer.spec.ts` |
| 6 | WIN pago sobre BET já reembolsada | sim — **o mais grave** | ✅ corrigido | `reference-policy.spec.ts` (UT-T18), `transactions.spec.ts` |
| 7 | Lock na referência antes de validar a wallet | sim | ✅ corrigido (lock removido) | suítes de concorrência inalteradas e verdes |
| 8 | Invariante do ledger ausente em testes | em parte | ✅ completado | `failure-paths.spec.ts` |
| 9 | Ordem de eventos por wallet entre publishers | em parte (já havia `walletVersion`) | ✅ documentado como *best effort* | docs/01 D-08, ARCHITECTURE |

---

## 2. Os achados e as correções

### 1. `FAILED` nunca era produzido

**O que procedia.**
- `WagerTransaction.fail()` não tinha chamador.
- Uma mensagem que esgotava as tentativas ia para a DLQ pelo redrive do SQS, e o banco não guardava nada.
- O enunciado (§6.3) e a decisão D-09 prometem `FAILED` como "erro permanente de infraestrutura, terminal e auditável".

**Correção.** Na **última recepção** (`receiveCount >= SQS_MAX_RECEIVE_COUNT`), o consumidor deixa de devolver a mensagem à fila e:
1. Grava a operação como `FAILED INFRA_RETRIES_EXHAUSTED`, com a auditoria `FAILED` e o evento `WagerTransactionFailed` na outbox, numa transação curta:
   - não move saldo, então não trava a wallet, já que a causa da falha pode ser justamente o lock;
   - a unicidade da chave decide se a operação já existe;
   - a inbox também é gravada.
2. Manda a mensagem para a DLQ **pela aplicação**, com motivo `retries_exhausted`, e dá ack.

Se nem o registro for possível (banco fora), a mensagem vai para a DLQ sem registro e pode ser
reprocessada depois por redrive manual. Se a operação foi decidida por outra entrega nesse
meio-tempo, só confirma.

**HTTP.** O replay de uma operação `FAILED` devolve **500 `INFRA_RETRIES_EXHAUSTED`, sem
`Retry-After`**, nunca 422. É falha de infraestrutura, não regra de negócio, e é terminal:
repetir a mesma chave devolve sempre o mesmo resultado.

**Limite conhecido.**
- Inserir a transação `FAILED` checa a FK para `wallets`, e essa checagem pede `FOR KEY SHARE`, que conflita com o `FOR UPDATE` do lock da wallet.
- Numa wallet presa por mais que o `lock_timeout`, o registro também espera e pode falhar; nesse caso, a mensagem vai à DLQ sem registro.
- A saída completa seria travar a wallet com `FOR NO KEY UPDATE`, que o MikroORM não expõe. Ficou fora para não mexer no lock central no fim do projeto.

### 2. A métrica de DLQ não via o redrive

**O que procedia.** `wagering_dlq_messages_total` só contava os envios feitos pela aplicação.
O redrive por `maxReceiveCount` acontece dentro do SQS.

**Correção, em duas camadas:**
- Com a correção 1, a última recepção passa a ir para a DLQ **pela aplicação** (`reason="retries_exhausted"`), então a métrica conta.
- Novo gauge **`wagering_queue_depth{queue}`**, lido a cada 15 s pelo papel `scheduler` (`GetQueueAttributes`). Ele vê qualquer mensagem na DLQ, inclusive as movidas pelo redrive quando o processo cai em loop sem conseguir tratar a mensagem.
- O alerta "DLQ recebendo" usa os dois e fica ativo **até a DLQ ser tratada**.
- Na AWS, o equivalente é `ApproximateNumberOfMessagesVisible` no CloudWatch.

### 3. Erro de programação tratado como transitório

**O que procedia.** Tudo que não era `DomainError` caía no backoff, inclusive
`InvariantViolationError`.

**Correção.**
- `InvariantViolationError`, e também `TypeError`, `RangeError` e `ReferenceError` **sem `code` de sistema**, vão **direto para a DLQ** com motivo `bug`.
- Erros com categoria `permanent` também vão direto.
- O que continua desconhecido segue com retry limitado.

**Por que "desconhecido = tente de novo" continua.** Um caso real deste projeto: com o
Postgres parado, o driver lançava `getaddrinfo ETIMEOUT`, que não estava classificado (achado
da suíte de evidências). Se desconhecido fosse permanente, toda queda do banco jogaria
mensagens na DLQ. O custo do retry é baixo: ~1 min até a DLQ.

### 4. A ordem FIFO quebrava dentro do lote

**O que procedia.** Se a mensagem N de um grupo falhava de forma transitória, a N+1 do mesmo
grupo era processada antes dela. Com duas BETs disputando saldo, a falha transitória decidia
qual delas seria rejeitada.

**Correção.**
- Na primeira falha transitória de um grupo, as mensagens seguintes **voltam para a fila com o mesmo atraso, sem serem processadas**.
- Teste: duas BETs de 80.00 sobre 100.00, a primeira com uma falha transitória injetada. A primeira termina `PROCESSED` e a segunda `REJECTED`, como na ordem de envio.

### 5. Rejeições pela fila sem aviso ao provedor

**O que procedia em parte.**
- Rejeições de negócio com transação (saldo, referência…) já viravam `REJECTED` com `WagerTransactionRejected`.
- Conflitos de idempotência pela fila já eram auditados, mas não geravam evento.
- Wallet inexistente pela fila não deixava nada.

**Correção.**
- Novo evento **`WagerOperationRejected`**, publicado pela outbox na mesma transação, para operações recusadas **sem transação própria**:
  - conflito de idempotência (payload divergente ou mesma operação com outra chave), com `originalTransactionId`;
  - wallet inexistente.
- Pelo HTTP nada muda: a resposta 409 ou 404 já é o aviso.

### 6. WIN sobre BET já reembolsada — o mais grave

**O que procedia.** A política só checava uma reversão existente quando a operação nova era
uma reversão. Um `WIN` sobre uma BET já `REFUND`ada pagava o reembolso **e** o prêmio.

**Correção.**
- Toda operação que referencia outra é rejeitada se a referência já foi revertida.
- Para `WIN` e `LOSS`, isso significa que uma BET reembolsada ou revertida deixou de existir economicamente: `REJECTED REFERENCE_ALREADY_REVERSED`, apontando a reversão.
- Testes de unidade (WIN e LOSS) e o fluxo HTTP completo (BET → REFUND → WIN = 422, saldo intacto).

### 7. Lock na referência antes de validar a wallet

**O que procedia.** O `FOR UPDATE` na referência vinha antes da checagem de contexto.

**Correção.** O lock foi **removido**. Ele era redundante:
- uma referência válida pertence à mesma wallet, já travada, e toda mudança nela acontece sob esse lock;
- a reversão única tem a última barreira no índice `uq_tx_single_reversal`.

O lock só tinha efeito no caso inválido (referência de **outra** wallet), onde travava uma
linha alheia e abria espaço para deadlock entre wallets. Agora cada operação toma **um único
lock**, o da wallet. As suítes de concorrência (CT-01 a CT-12) continuam verdes.

### 8. Invariante do ledger em todos os testes

**O que procedia em parte.**
- `transactions.spec.ts` já chamava `assertLedgerConsistency` 5 vezes.
- Faltava em `failure-paths.spec.ts`, e agora está lá.

O trigger *deferred* `trg_wallet_matches_ledger` também confere `saldo == último lançamento`
em **todo commit de todo teste**.

### 9. Ordem dos eventos por wallet

**O que procedia em parte.**
- Um evento reagendado por falha pode sair depois de um posterior da mesma wallet.
- `docs/03` já dizia que `walletVersion` permite ordenar, mas D-08 e ARCHITECTURE prometiam "ordem por wallet".

**Decisão.** A ordem é **best effort**, e a garantia é `walletVersion`. Garantir ordem estrita
exigiria bloquear todos os eventos da wallet até o que falhou sair (*head-of-line blocking*):
uma falha pontual pararia a wallet inteira. A documentação foi corrigida.

---

## 3. As 14 perguntas

**1. Onde uma transação vira `FAILED`? Após 5 timeouts de lock, como se descobre o que houve?**
- No consumidor, na última recepção com erro transitório (achado 1): `FAILED INFRA_RETRIES_EXHAUSTED`, com auditoria, evento `WagerTransactionFailed`, cópia na DLQ (`reason=retries_exhausted`) e alerta.
- Consulta: `GET /providers/:p/wagering/transactions/:id` e a linha do tempo em `/audit`.
- Cada tentativa anterior fica no log com `messageId`, `walletId`, `providerId` e `receiveCount`.
- Tempo até lá: 5 tentativas com 2, 4, 8 e 16 s de espera, mais até 5 s de lock em cada uma, cerca de 55 s no total.

**2. Como monitorar mensagens que chegam à DLQ por redrive?**
- Pelo gauge `wagering_queue_depth{queue="wager_dlq"}` (achado 2), que alimenta o alerta "DLQ recebendo".
- Na AWS, pelo CloudWatch.

**3. Por que um bug era reprocessado 5 vezes? Qual o critério para "inesperado = transitório"?**
- Era. Agora vai direto para a DLQ (motivo `bug`).
- O critério para o que continua desconhecido é conservador e foi justificado por um caso real (`ETIMEOUT`): melhor ~1 min de retry do que perder a disponibilidade em toda queda de banco.

**4. Se a mensagem 1 do grupo falha e a 2 é processada, que ordem você garante?**
- Agora, a ordem do grupo: a 2 volta junto com a 1, sem ser processada (achado 4).
- O banco sempre garantiu que no máximo uma BET passa e que o saldo nunca fica negativo. A correção garante também *qual* passa.

**5. Depois de um `ROLLBACK` do `REFUND`, a BET pode ser reembolsada de novo?**
- Não. `uq_tx_single_reversal` permite uma única reversão `PROCESSED` por referência, e o `REFUND` original continua `PROCESSED`.
- Motivo: a cadeia de reversões fica **linear** (BET ← REFUND ← ROLLBACK). Permitir outro `REFUND` abriria ciclos, cada um movendo dinheiro, e o estado econômico da BET só sairia percorrendo a cadeia.
- Reembolsar de novo é uma operação nova (ajuste manual auditado).
- "Qualquer tipo" em vez de "mesmo tipo" (D-01) existe para impedir crédito duplo de `REFUND` e `ROLLBACK` sobre a mesma BET.

**6. WIN sobre BET reembolsada é intencional?**
- Não era. Foi corrigido (achado 6): agora é rejeitado com `REFERENCE_ALREADY_REVERSED`.
- Em agregadores reais, uma aposta cancelada não é liquidada depois.

**7. ROLLBACK antes da BET: avaliou rejeitar a BET ("cancel antes do bet")?**
- Avaliei. Hoje o ROLLBACK fica `PENDING_REFERENCE`; a BET chega e é debitada; o ROLLBACK é aplicado e credita. Efeito líquido zero, as duas auditadas, ordem lógica preservada.
- O *tombstone* (rejeitar a BET que chega depois do cancelamento):
  - a favor: evita mover saldo à toa;
  - contra: a decisão sobre a BET passa a depender da ordem de chegada e de consultar pendências alheias.
- É decisão de produto e caberia na `ReferencePolicy` da BET.

**8. Com a wallet travada, o que o `FOR UPDATE` na referência protegia?**
- Nada no caso válido, e ele atrapalhava no caso inválido. Foi removido (achado 7).

**9. Por que pessimista? Qual o p99 de espera de lock numa hot wallet? O que o provedor recebe no estouro?**

Números do [relatório de carga](./load-test-report.md), 50 VUs numa wallet com 3 réplicas:
- ~189 req/s, todas aplicadas, 0 timeouts;
- espera média de lock de 152 ms; p99 da resposta de 588 ms, que limita por cima o p99 do lock.

Configuração e resposta:
- `DB_LOCK_TIMEOUT_MS` (5 s), aplicado com `SET LOCAL lock_timeout`; `DB_STATEMENT_TIMEOUT_MS` de 10 s.
- No estouro: **503 `INFRA_UNAVAILABLE` + `Retry-After: 1`**. O reenvio com a mesma chave é seguro.

Por que pessimista: numa hot wallet o conflito é a regra. O otimista viraria tempestade de
retries, com cada perdedor refazendo todo o trabalho. O pessimista vira fila ordenada.

**10. Custo por commit do trigger deferred? Com ele, quando a reconciliação acharia algo?**

Custo:
- Uma busca por wallet alterada: `ORDER BY wallet_version DESC LIMIT 1` sobre o índice único `(wallet_id, wallet_version)`.
- É a leitura do fim do índice, O(log n), na casa de microssegundos.

A reconciliação é **detector**, não barreira. Ela acharia o que contorna os triggers:
- `session_replication_role = replica` ou `DISABLE TRIGGER` por um superusuário;
- restauração parcial de backup;
- migration futura com bug;
- corrupção.

Ela também confere a soma completa e os buracos de versão, que o trigger não olha.

**11. Mesma operação via HTTP e SQS com chaves diferentes: como o provedor fica sabendo?**
- HTTP: 409 `IDEMPOTENCY_KEY_MISMATCH`.
- Fila: ack, auditoria `IDEMPOTENCY_CONFLICT` e, agora, o evento `WagerOperationRejected` com `originalTransactionId` (achado 5).

**12. Evento que o SQS sempre recusa fica em retry infinito?**
- Fica, de propósito: um evento confirmado junto com o dinheiro nunca é descartado.
- É visível, porque o atraso da outbox mede o evento **não publicado** mais antigo. Um único evento preso dispara "Outbox atrasada" (30 s) e depois "Outbox parada" (5 min, crítico); `retries_total{component="outbox"}` também sobe.
- Não bloqueia os outros eventos.
- O SQS só recusaria sempre um payload acima de 256 KB ou com caracteres inválidos, e os eventos são gerados pelo próprio sistema, pequenos.
- Melhoria possível: limite de tentativas que marca o evento como "morto", com alerta próprio.

**13. Por que o hash do inbox inclui a `idempotencyKey` e o `payloadHash` não?**

São perguntas diferentes:
- **`payloadHash`** responde "é a mesma operação?". A busca já é *pela* chave, e para detectar "mesma operação com outra chave" (`KEY_MISMATCH`) o hash precisa ser igual com chaves diferentes.
- **Hash do inbox** responde "é a mesma mensagem?". O mesmo `messageId` com outra chave é anomalia do produtor (D-14) e precisa ser detectado.

**14. Escopo extra: quanto tempo? Antes ou depois do obrigatório?**
- Depois. I0 a I7 fecharam todo o obrigatório (§1–§13 ✅ em `docs/07`), e só então a I8 trouxe os diferenciais.
- A auditoria não é extra: o enunciado a exige ("ledger sem auditoria" é falha eliminatória).
- A sessão de jogador é um ponto de extensão no-op.
- Grafana, alertas e e-mail ficam num perfil isolado do Compose, fora do caminho financeiro.
- *(Complete com o tempo que você dedicou a cada fase.)*

---

## 4. Todos os retries: motivo, quantidade e por quê

### 4.1 Tabela geral

| Onde | Motivo | Quantidade | Espera entre tentativas | Até desistir | Ao esgotar | Configuração |
|---|---|---|---|---|---|---|
| **Consumidor SQS** — transitório/desconhecido | Postgres fora, DNS/rede, `lock_timeout`, `statement_timeout`, deadlock, pool esgotado | **5 recepções** | `min(2ⁿ, 300) s` + jitter ≤ 20%: **2, 4, 8, 16 s** | **≈ 30 s** de espera, mais o tempo de cada tentativa (até 5 s de lock) | **`FAILED INFRA_RETRIES_EXHAUSTED`** + evento + DLQ `retries_exhausted` | `SQS_MAX_RECEIVE_COUNT=5` |
| **Consumidor SQS** — permanente | JSON/schema inválido, `type` desconhecido, validação, mesmo `messageId` com outro conteúdo | **0** | — | imediato | DLQ com motivo + ack | — |
| **Consumidor SQS** — bug | `InvariantViolationError`, `TypeError`/`RangeError`/`ReferenceError` sem `code` | **0** | — | imediato | DLQ `bug` | — |
| **Consumidor SQS** — negócio/conflito | saldo, referência, conflito de idempotência, wallet inexistente | **0** | — | imediato | ack (+ `REJECTED` ou `WagerOperationRejected`) | — |
| **Consumidor SQS** — processo caindo em loop | o processo morre sempre na mesma mensagem (sem ack nem visibilidade) | 5 recepções | o visibility timeout (60 s) | ~5 min | **redrive do SQS** para a DLQ, visto pelo `queue_depth` | `SQS_VISIBILITY_TIMEOUT_SECONDS` |
| **Referência pendente** | a referência ainda não chegou | **10 tentativas** ou **TTL de 15 min** | `min(1 s × 2ⁿ, 60 s)` + jitter de 20%: **1, 2, 4, 8, 16, 32, 60, 60, 60 s** | **≈ 4 min** (243 s) | `REJECTED REFERENCE_NOT_FOUND` + evento | `REFERENCE_RETRY_*` |
| **Publicador da outbox** | SQS fora, throttling, falha parcial do lote | **ilimitada** | `min(1 s × 2ⁿ⁻¹, 300 s)`: 1, 2, 4 … 256, depois 300 s | nunca | alertas de atraso (30 s / 5 min) | código (`OutboxMessage`) |
| **HTTP** — corrida de unicidade | mesma chave ou operação ao mesmo tempo em **wallets diferentes** | **1 releitura** | imediata | — | replay (200) ou conflito (409) | `RETRYABLE_UNIQUE` |
| **HTTP** — lock, banco ou rede | wallet ocupada além do `lock_timeout`; Postgres/DNS fora | **0 no servidor** | o **provedor** reenvia após `Retry-After: 1` | até 5 s esperando o lock | **503 `INFRA_UNAVAILABLE`** | `DB_LOCK_TIMEOUT_MS=5000` |
| **Workers** (`PollingLoop`) | erro numa rodada (outbox, pendências, retenção, profundidade) | ilimitada | o intervalo do worker | nunca | log; o trabalho reservado fica com o lease | `*_INTERVAL_MS` |
| **Lease** | processo morreu com eventos ou pendências reservados | 1 retomada por expiração | **30 s** | — | outra instância assume | `OUTBOX_LEASE_MS`, `PENDING_WORKER_LEASE_MS` |
| **AWS SDK** | throttling, 5xx e rede dentro de uma chamada | **3 tentativas** (padrão do SDK v3) | backoff do SDK | segundos | o erro sobe para o laço do componente | padrão |

Sobre o consumidor: com `maxReceiveCount = 5`, as recepções 1 a 4 esperam 2, 4, 8 e 16 s, e a
5ª, se falhar, já registra o `FAILED`. Antes da revisão, a 5ª ainda esperava 32 s e só então o
SQS fazia o redrive.

### 4.2 Por que esses números

- **Consumidor: 5 recepções, de 2 a 16 s.** Falhas transitórias típicas (lock disputado, failover, pico) passam em segundos. Cerca de 30 s cobre isso; mais do que isso só segura uma operação que precisa de um humano. O teto de 300 s protege caso `maxReceiveCount` seja aumentado, e o jitter evita que a rajada inteira volte junta.
- **Retry da fila com espera, não imediato.** Repetir no mesmo instante contra o banco que acabou de falhar piora o incidente.
- **Referência: 10 tentativas ou 15 min.** Provedores reenviam a referência em segundos. ~4 min cobrem atrasos reais sem segurar a conciliação do provedor. O TTL protege quando o worker ficou parado.
- **Outbox sem limite.** O evento já foi confirmado junto com o dinheiro; descartá-lo quebraria o contrato da outbox. O alerta transforma "preso" em incidente.
- **HTTP sem retry no servidor.** Quem decide repetir é o cliente, informado pelo 503 com `Retry-After`, e a idempotência torna o reenvio seguro. Um retry interno esconderia latência e poderia estourar o timeout do cliente com a operação já aplicada, gerando um reenvio concorrente.
- **Uma única releitura no HTTP.** A corrida em wallets diferentes não é serializada pelo lock, então quem desempata é o `UNIQUE`. Depois dele, a vencedora já está visível.
- **Lease de 30 s.** É maior que uma rodada (milissegundos a segundos) e curto o bastante para retomar rápido depois de um `SIGKILL` (CT-06).

### 4.3 Como cada retry aparece na operação

| Retry | Métrica | Alerta |
|---|---|---|
| consumidor | `wagering_retries_total{component="consumer"}` | "Retries elevados" (> 50 em 15 min) |
| tentativas esgotadas | `wagering_dlq_messages_total{reason="retries_exhausted"}`, transações `FAILED` | "DLQ recebendo" |
| redrive do SQS | `wagering_queue_depth{queue="wager_dlq"}` | "DLQ recebendo" |
| referência | `wagering_retries_total{component="pending_worker"}`, `wagering_pending_references` | "Referências pendentes acumulando" (> 100) |
| outbox | `wagering_retries_total{component="outbox"}`, atraso por SQL | "Outbox atrasada" (30 s), "Outbox parada" (5 min, crítico) |
| lock | `wagering_lock_timeouts_total`, `wagering_lock_wait_seconds` | "Gargalo: hot wallet" |
