# 02 — Escopo Ágil

> O backlog é organizado em **épicos → histórias → critérios de aceite** (Given/When/Then). Cada iteração entrega um **incremento vertical testável**. A ordem segue o peso da avaliação e as dependências técnicas.

## 1. Princípios

- **Correção antes de feature:** nenhuma história é "pronta" sem o teste que prova sua invariante.
- **TDD:** teste vermelho → implementação mínima → refatoração (ver [04-estrategia-testes.md](./04-estrategia-testes.md)).
- **Fatia vertical:** cada iteração termina com `docker compose up` funcional e testes verdes.
- **Timebox consciente:** autenticação e diferenciais só entram depois do núcleo (MoSCoW).

## 2. Definition of Ready (DoR)

Uma história só entra na iteração se tiver:
- critérios de aceite em Given/When/Then;
- invariantes afetadas identificadas (ver [01 §4](./01-analise-requisitos.md#4-invariantes-globais-o-que-nunca-pode-quebrar));
- decisões ambíguas resolvidas e registradas.

## 3. Definition of Done (DoD)

- [ ] Testes escritos **antes** do código (commit do teste vermelho visível no histórico quando fizer sentido)
- [ ] `bun test` verde (unidade + integração afetada)
- [ ] `bun run lint` e `bun run typecheck` (TS `strict`) sem erros
- [ ] Constraints de banco cobrindo a invariante, com migration `up/down`
- [ ] Logs estruturados e métricas da funcionalidade
- [ ] `ARCHITECTURE.md` atualizado se houve decisão
- [ ] Invariante final verificada: `wallet.balance == saldo reconstruído pelo ledger`

## 4. Priorização (MoSCoW)

| Prioridade | Itens |
|---|---|
| **Must** | Money, Wallet, ledger, transações e regras, idempotência, concorrência, inbox, outbox, SQS + DLQ, pending reference worker, reconciliação, health, testes obrigatórios, README/ARCHITECTURE |
| **Should** | Métricas Prometheus, graceful shutdown completo, cursor opaco no ledger, problem details |
| **Could** | Teste de carga (`test:load`), OpenTelemetry + dashboards e alertas no Grafana, ledger double-entry |
| **Won't (agora)** | Autenticação real com IdP (fica `AuthGuard` no-op + desenho documentado), reversão parcial, multi-moeda com escalas diferentes de 2 |

## 5. Épicos e histórias

Estimativa em *story points* (Fibonacci). Prefixo da história = épico.

### E0 — Fundação do projeto
| ID | História | Pts |
|---|---|---|
| E0-1 | Como dev, quero o projeto NestJS rodando em Bun com TS `strict`, lint e formatação | 2 |
| E0-2 | Como dev, quero `docker compose up` subindo Postgres, LocalStack (filas criadas) e a aplicação | 3 |
| E0-3 | Como dev, quero MikroORM configurado com migrations reversíveis | 3 |
| E0-4 | Como dev, quero a infraestrutura de testes de integração com Testcontainers (Postgres + LocalStack) | 3 |
| E0-5 | Como operador, quero logs JSON com `correlationId` desde o primeiro endpoint | 2 |

**Aceite E0-2:** *Given* um clone limpo, *When* rodo `docker compose up -d`, *Then* `GET /health/ready` responde `200` e as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events.fifo` existem.

### E1 — Núcleo de domínio (puro, sem framework)
| ID | História | Pts |
|---|---|---|
| E1-1 | `Money` imutável, exato, 2 casas, multi-moeda, validação de entrada | 3 |
| E1-2 | `Wallet` (aggregate root) com `debit/credit` gerando o lançamento do ledger | 5 |
| E1-3 | `WagerTransaction` com máquina de estados e estados terminais | 5 |
| E1-4 | `WalletLedgerEntry` imutável com aritmética validada | 2 |
| E1-5 | Política de referência (`ReferencePolicy`): mesmo provider/player/wallet/moeda/rodada, kind permitido, valor igual, reversão única | 5 |
| E1-6 | `InboxMessage`, `OutboxMessage` e `IntegrationEvent` (classe abstrata + 4 subclasses) | 3 |

**Aceite E1-2:** *Given* wallet com `100.00 BRL`, *When* `debit(80.00)`, *Then* saldo `20.00`, `version` 2 e um lançamento `DEBIT` com `before 100.00 / after 20.00`; *When* `debit(30.00)` em seguida, *Then* lança `InsufficientFundsError` e o estado não muda.

### E2 — Wallets (persistência + API)
| ID | História | Pts |
|---|---|---|
| E2-1 | Schema `wallets`, `wager_transactions`, `wallet_ledger_entries` com todas as constraints | 5 |
| E2-2 | `POST /wallets` com `OPENING` atômico | 3 |
| E2-3 | `GET /wallets/:id` e `GET /wallets/:id/ledger` com cursor opaco | 3 |
| E2-4 | `POST /wallets/:id/reconciliation` com métrica e log de divergência | 3 |
| E2-5 | Conexão de leitura separada (`DATABASE_READ_URL`) para ledger, reconciliação, notificador e Grafana; *read-your-writes* no primário | 2 |

**Aceite E2-2:** *Given* um `playerId` sem wallet BRL, *When* `POST /wallets` com `1000.00`, *Then* `201`, `version 1`, existe uma transação `OPENING PROCESSED` e um `CREDIT 1000.00`; *When* repito, *Then* `409 WALLET_ALREADY_EXISTS`.

### E3 — Processamento de transações (HTTP)
| ID | História | Pts |
|---|---|---|
| E3-1 | Use case `ProcessWagerTransaction` com lock pessimista por wallet | 8 |
| E3-2 | Idempotência: `payloadHash` canônico, replay fiel, conflito | 5 |
| E3-3 | `POST /wagering/transactions` com mapeamento HTTP consistente | 3 |
| E3-4 | `BET`, `WIN`, `LOSS` | 3 |
| E3-5 | `REFUND` e `ROLLBACK` por **um único fluxo de reversão** (`ReverseTransaction`), parametrizado por kind | 5 |
| E3-6 | Consultas de transação (id interno e id do provedor) | 2 |
| E3-7 | Cenário obrigatório: duas `BET 80.00` simultâneas sobre `100.00` | 3 |
| E3-8 | Como auditor, quero a linha do tempo imutável de cada transação (decisões, retries, replays, conflitos, lançamento gerado, reversão relacionada) | 5 |
| E3-9 | Porta `PlayerSessionPolicy` (no-op) chamada antes de cada `BET` + `playerId` validado como UUID no contrato | 1 |

**Aceite E3-5:** *Given* uma `BET` processada, *When* chegam `REFUND` e `ROLLBACK` dela (em qualquer ordem ou em paralelo), *Then* a primeira é `PROCESSED` com um `CREDIT`, a segunda é `REJECTED REFERENCE_ALREADY_REVERSED` com `relatedTransactionId` apontando a primeira, e o saldo é creditado uma única vez.

**Aceite E3-8:** *Given* uma `BET` que foi aplicada, reenviada 2× e depois revertida, *When* consulto `GET /wagering/transactions/:id/audit`, *Then* vejo em ordem: `PROCESSED` (com `ledgerEntryId`), 2× `IDEMPOTENT_REPLAY` e `REVERSED_BY` (com a transação de reversão), cada um com origem (HTTP/SQS/WORKER), `correlationId` e instância; e *When* tento `UPDATE`/`DELETE` na tabela de auditoria, *Then* o banco recusa.

**Aceite E3-7:** *Given* saldo `100.00`, *When* duas `BET 80.00` (keys diferentes) em paralelo, *Then* exatamente uma `PROCESSED`, outra `REJECTED INSUFFICIENT_FUNDS`, saldo `20.00`, um único `DEBIT`.

### E4 — Outbox e eventos
| ID | História | Pts |
|---|---|---|
| E4-1 | Eventos gravados na outbox na mesma transação SQL | 3 |
| E4-2 | Publisher com claim por lease (`FOR UPDATE SKIP LOCKED`), backoff e `SendMessageBatch` | 5 |
| E4-3 | Recuperação: processo morre após commit e antes de publicar → outra instância publica | 3 |
| E4-4 | Job de retenção de inbox processada e outbox publicada (> 7 dias, em lotes); ledger e auditoria intocáveis | 2 |

### E5 — Consumo SQS
| ID | História | Pts |
|---|---|---|
| E5-1 | Consumidor com inbox persistente na mesma transação | 5 |
| E5-2 | Classificação de erro: negócio (ack) / transitório (backoff) / permanente (DLQ) | 5 |
| E5-3 | Limite de tentativas + redrive para DLQ | 2 |
| E5-4 | Graceful shutdown em `SIGTERM` (drena ou devolve visibilidade) | 3 |

**Aceite E5-1:** *Given* uma mensagem já processada, *When* ela é reentregue, *Then* nenhum efeito novo, contador `duplicates_detected_total` incrementa e a mensagem é removida da fila.

### E6 — Referências fora de ordem
| ID | História | Pts |
|---|---|---|
| E6-1 | Persistir `PENDING_REFERENCE` + evento | 2 |
| E6-2 | Worker agendado com backoff exponencial e lease | 5 |
| E6-3 | Expiração: `REJECTED REFERENCE_NOT_FOUND` + evento | 2 |

### E7 — Observabilidade e operação
| ID | História | Pts |
|---|---|---|
| E7-1 | Métricas (`/metrics`): status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência | 3 |
| E7-2 | `GET /health/live` e `/health/ready` | 1 |
| E7-3 | Redaction de dados sensíveis nos logs | 1 |
| E7-4 | Instrumentação OpenTelemetry (traces por use case + métricas de negócio do catálogo) | 5 |
| E7-5 | Perfil `observability`: `otel-lgtm` + Alloy + `postgres-exporter` + Mailpit, com dashboards "Operação" e "Auditoria financeira" provisionados | 5 |
| E7-6 | Alertas no Grafana Alerting com três níveis (crítico/médio/leve) e políticas de envio, incluindo atraso, gargalo e aumento de fila | 3 |

| E7-7 | Como operador, quero receber por e-mail um relatório de incidente com análise, último cliente afetado, impacto, atraso, gargalo provável, filas, desfecho e nível (crítico/médio/leve) | 8 |
| E7-8 | Runbook por alerta em `docs/runbooks/` (linkado no e-mail) | 2 |
| E7-9 | Alertas antifraude por SQL na auditoria: velocidade de reversões por jogador e apostas em jogos simultâneos | 2 |

**Aceite E7-7:** *Given* 3 instâncias rodando, *When* forço uma mensagem para a DLQ, *Then* chega ao Mailpit um e-mail "[🟠 MÉDIO] DLQ recebendo — INC-n (DISPARADO)" com o último cliente afetado (`playerId` mascarado), o desfecho "mensagem na DLQ, transação não aplicada", a profundidade das filas e o link do runbook; *When* o Grafana reenvia o mesmo alerta, *Then* nenhum e-mail duplicado; *When* o alerta resolve, *Then* chega o e-mail "[RESOLVIDO]" com a duração.

**Aceite E7-6:** *Given* um clone limpo sem `.env`, *When* `docker compose --profile observability up` e forço uma mensagem para a DLQ, *Then* o alerta "DLQ recebendo" dispara e o e-mail aparece no Mailpit (`localhost:8025`); *When* defino `SMTP_*` no `.env`, *Then* o mesmo alerta chega pelo SMTP real.

### E8 — Testes de resiliência e carga
| ID | História | Pts |
|---|---|---|
| E8-1 | Suíte de concorrência com 3 processos reais | 5 |
| E8-2 | Testes de crash (fault injection após commit / antes do ack) | 5 |
| E8-3 | `bun run test:load` (k6) com relatório honesto | 5 |
| E8-4 | Teste de escala horizontal (ST-08): 1 × 3 instâncias, ganho e ponto de saturação | 3 |

### E9 — Documentação e autenticação (extensão)
| ID | História | Pts |
|---|---|---|
| E9-1 | `README.md` com setup e comandos | 1 |
| E9-2 | `ARCHITECTURE.md` com decisões, trade-offs e limitações | 3 |
| E9-3 | `AuthGuard` no-op + `ProviderIdentityPort` + desenho com Keycloak documentado | 1 |

## 6. Plano de iterações

Total estimado: ~180 pts. As iterações são incrementos, não datas — a cadência real depende da disponibilidade.

```mermaid
gantt
    dateFormat X
    axisFormat %s
    title Iterações (ordem e dependências)
    section Fundação
    I0 Fundação (E0)                    :i0, 0, 13
    section Núcleo
    I1 Domínio puro (E1)                :i1, after i0, 23
    I2 Wallets + schema (E2)            :i2, after i1, 16
    section Transações
    I3 Processamento HTTP (E3)          :i3, after i2, 35
    section Mensageria
    I4 Outbox (E4)                      :i4, after i3, 13
    I5 SQS + pending ref (E5, E6)       :i5, after i4, 24
    section Qualidade
    I6 Observabilidade + resiliência (E7, E8) :i6, after i5, 48
    I7 Documentação final (E9)          :i7, after i6, 5
```

| Iteração | Meta (incremento) | Demonstração |
|---|---|---|
| **I0** ✅ | Esqueleto rodando | `docker compose up` + health verde + 1 teste de integração |
| **I1** ✅ | Domínio provado por testes | `bun test test/unit` 100% verde, sem Nest/ORM no domínio |

> **I1 entregue:** 193 testes de unidade (cobertura do domínio ≈ 95% das linhas) + teste de arquitetura que impede o domínio de importar framework/ORM/SDK e de converter valores para `number`. UT-A01 (registro de auditoria por transição) foi movido para a I3, porque a auditoria é efeito do use case, não do agregado.
| **I2** | Wallets persistidas com constraints | criar/consultar wallet; teste prova que `UPDATE` no ledger falha |
| **I3** | Transações via HTTP corretas sob concorrência | cenário 2× `BET 80` e 50 requisições paralelas idênticas |
| **I4** | Eventos confiáveis | matar processo entre commit e publish; evento chega |
| **I5** | Fila e fora de ordem | `ROLLBACK` antes da `BET` resolve sozinho |
| **I6** | Operável e medido | 3 instâncias, crash tests, dashboards, e-mail de incidente no Mailpit, relatório de carga |
| **I7** | Entregável | README + ARCHITECTURE revisados |

## 7. Riscos

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Incompatibilidade Bun × NestJS/MikroORM (decorators, `reflect-metadata`) | ~~média~~ **resolvido na I0** | alto | ✅ DI por construtor, MikroORM e migrations em `.ts` funcionam no Bun 1.4.2 |
| Testcontainers sob Bun | ~~média~~ **resolvido na I0** | médio | ✅ Postgres + LocalStack sobem em ~6 s; 7 testes de integração verdes |
| Testes de concorrência intermitentes (flaky) | alta | alto | barreira de sincronização, asserts só no estado final, repetição em loop no CI |
| Docker via snap (volumes fora do `/home`) | baixa | baixo | projeto está em `/home` |
| Escopo excessivo | média | alto | MoSCoW; diferenciais só após I6 |
| SDK OpenTelemetry com suporte parcial no Bun | média | médio | spike na I0; instrumentação manual de spans; fallback para `prom-client` + `/metrics` |
| Segredo de notificação vazar no repositório público | baixa | alto | só via `.env` (no `.gitignore`), `.env.example` sem valores |
