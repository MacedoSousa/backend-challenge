# 05 — Diagramas

> Diagramas em Mermaid; o GitHub e o VS Code (extensão *Markdown Preview Mermaid Support*) renderizam direto.

## 1. Contexto (C4 nível 1)

```mermaid
flowchart LR
    P1["Provedor de jogos A"] -- "HTTP POST /wagering/transactions" --> WP
    P2["Provedor de jogos B"] -- "SQS wager-transactions.fifo" --> WP
    OPS["Operação / Backoffice"] -- "consultas, reconciliação" --> WP
    WP["Distributed Wagering Processor"] -- "eventos de integração<br/>wagering-events.fifo" --> DS["Consumidores downstream<br/>(CRM, BI, antifraude)"]
    IDP["Identity Provider<br/>(Keycloak — extensão)"] -. "tokens OIDC" .-> WP
```

## 2. Implantação local (Docker Compose)

```mermaid
flowchart TB
    subgraph compose["docker compose"]
        direction TB
        subgraph apps["Aplicação — mesma imagem, N réplicas"]
            A1["app-1<br/>APP_ROLE=all"]
            A2["app-2<br/>APP_ROLE=all"]
            A3["app-3<br/>APP_ROLE=all"]
        end
        PG[("PostgreSQL 17")]
        subgraph LS["LocalStack (SQS)"]
            Q1["wager-transactions.fifo"]
            Q2["wager-transactions-dlq.fifo"]
            Q3["wagering-events.fifo"]
        end
        INIT["init: cria filas<br/>+ redrive policy"]
    end
    A1 & A2 & A3 --> PG
    A1 & A2 & A3 <--> Q1
    A1 & A2 & A3 --> Q2
    A1 & A2 & A3 --> Q3
    Q1 -. "maxReceiveCount=5" .-> Q2
    INIT --> LS
```

## 3. Componentes (hexagonal)

```mermaid
flowchart LR
    subgraph presentation["Driving adapters"]
        HC["WageringController<br/>WalletController"]
        SC["WagerTransactionConsumer (SQS)"]
        WK["PendingReferenceWorker<br/>OutboxPublisherWorker"]
    end
    subgraph application["Aplicação (use cases)"]
        UC1["ProcessWagerTransaction"]
        UC2["CreateWallet / Reconcile / Queries"]
        UC3["RetryPendingReferences"]
        UC4["PublishOutbox"]
    end
    subgraph domain["Domínio (TS puro)"]
        D1["Wallet (AR)"]
        D2["WagerTransaction"]
        D3["WalletLedgerEntry"]
        D4["Money (VO)"]
        D5["ReferencePolicy"]
        D6["IntegrationEvent + subclasses"]
    end
    subgraph ports["Portas"]
        P1["WalletRepository"]
        P2["WagerTransactionRepository"]
        P3["OutboxRepository / InboxRepository"]
        P4["UnitOfWork"]
        P5["MessagePublisher"]
        P6["Clock / IdGenerator / Metrics"]
    end
    subgraph infra["Driven adapters"]
        I1["MikroORM repos + EntityManager"]
        I2["SQS client (AWS SDK v3)"]
        I3["Prometheus / pino"]
    end
    HC --> UC1 & UC2
    SC --> UC1
    WK --> UC3 & UC4
    UC1 & UC2 & UC3 & UC4 --> domain
    UC1 & UC2 & UC3 & UC4 --> ports
    P1 & P2 & P3 & P4 -.implementa.- I1
    P5 -.implementa.- I2
    P6 -.implementa.- I3
```

## 4. Modelo de dados (ER)

```mermaid
erDiagram
    WALLETS ||--o{ WAGER_TRANSACTIONS : "recebe"
    WALLETS ||--o{ WALLET_LEDGER_ENTRIES : "registra"
    WAGER_TRANSACTIONS ||--o| WALLET_LEDGER_ENTRIES : "gera no máx. 1"
    WAGER_TRANSACTIONS |o--o| WAGER_TRANSACTIONS : "referencia (REFUND/ROLLBACK/WIN)"
    WAGER_TRANSACTIONS ||--|{ WAGER_TRANSACTION_AUDIT : "linha do tempo"
    WALLET_LEDGER_ENTRIES |o--o{ WAGER_TRANSACTION_AUDIT : "rastreia o dinheiro"

    WALLETS {
        uuid id PK
        uuid player_id "UNIQUE(player_id, currency)"
        char3 currency
        numeric balance "CHECK >= 0"
        int version "CHECK >= 1"
    }
    WAGER_TRANSACTIONS {
        uuid id PK
        text provider_id "UNIQUE(provider_id, external_transaction_id)"
        text external_transaction_id
        text idempotency_key "UNIQUE"
        char64 payload_hash
        uuid wallet_id FK
        text kind "CHECK enum"
        numeric amount
        text status "CHECK enum"
        text failure_code
        uuid reference_transaction_id FK "UNIQUE parcial p/ reversão"
        numeric balance_after "snapshot p/ replay"
        int attempts
        timestamptz next_attempt_at
    }
    WALLET_LEDGER_ENTRIES {
        uuid id PK
        uuid wallet_id FK "UNIQUE(wallet_id, wallet_version)"
        int wallet_version
        uuid transaction_id FK "UNIQUE(transaction_id, wallet_id)"
        text direction
        numeric amount "CHECK > 0"
        numeric balance_before
        numeric balance_after "CHECK aritmética"
    }
    WAGER_TRANSACTION_AUDIT {
        uuid id PK
        uuid transaction_id FK
        uuid wallet_id FK
        text action "PROCESSED, REJECTED, REPLAY, REVERSED_BY..."
        text from_status
        text to_status
        text failure_code
        uuid ledger_entry_id FK
        uuid related_transaction_id FK
        text source "HTTP, SQS, WORKER"
        text correlation_id
        text instance_id
        timestamptz occurred_at "append-only"
    }
    INBOX_MESSAGES {
        text consumer_name PK
        text message_id PK
        char64 payload_hash
        timestamptz processed_at
    }
    OUTBOX_MESSAGES {
        uuid id PK "= eventId"
        uuid aggregate_id
        text event_type
        jsonb payload
        int attempts
        timestamptz next_attempt_at
        timestamptz locked_until
        timestamptz published_at
    }
```

## 5. Máquina de estados — `WagerTransaction`

```mermaid
stateDiagram-v2
    [*] --> PENDING : create()
    PENDING --> PROCESSED : aplicada (markProcessed)
    PENDING --> REJECTED : regra de negócio (reject)
    PENDING --> PENDING_REFERENCE : referência ausente
    PENDING --> FAILED : erro permanente de infra
    PENDING_REFERENCE --> PROCESSED : referência chegou e é válida
    PENDING_REFERENCE --> REJECTED : referência inválida / TTL esgotado
    PENDING_REFERENCE --> FAILED : tentativas de infra esgotadas
    PENDING_REFERENCE --> PENDING_REFERENCE : retry com backoff
    PROCESSED --> [*]
    REJECTED --> [*]
    FAILED --> [*]
    note right of PROCESSED
        Estados terminais: qualquer transição
        lança InvalidTransactionStateError
    end note
```

> `PENDING` é transitório **dentro** da transação SQL: na prática, uma transação recém-criada é persistida já em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`.

## 6. Sequência — submissão HTTP (caminho feliz + idempotência)

```mermaid
sequenceDiagram
    autonumber
    participant P as Provedor
    participant C as WageringController
    participant U as ProcessWagerTransaction
    participant DB as PostgreSQL
    P->>C: POST /wagering/transactions (Idempotency-Key)
    C->>C: valida schema (zod), calcula payloadHash canônico
    C->>U: execute(command)
    U->>DB: BEGIN
    U->>DB: SELECT wallet ... FOR UPDATE
    Note over U,DB: serializa por walletId (não global)
    U->>DB: SELECT tx WHERE idempotency_key = ?
    alt já existe
        alt hash igual
            U-->>C: resultado original (idempotentReplay=true)
        else hash diferente
            U-->>C: IdempotencyPayloadMismatch → 409
        end
        U->>DB: ROLLBACK (nada a escrever)
    else nova
        U->>U: Wallet.debit/credit → LedgerEntry<br/>WagerTransaction.markProcessed
        U->>DB: UPDATE wallets (balance, version)
        U->>DB: INSERT wager_transactions
        U->>DB: INSERT wallet_ledger_entries
        U->>DB: INSERT outbox_messages (Processed, BalanceChanged)
        U->>DB: COMMIT
        U-->>C: resultado (idempotentReplay=false)
    end
    C-->>P: 201 / 200 / 409 / 422 / 202
```

## 7. Cenário obrigatório — duas apostas concorrentes

```mermaid
sequenceDiagram
    autonumber
    participant I1 as Instância 1 (BET 80)
    participant DB as PostgreSQL
    participant I2 as Instância 2 (BET 80)
    I1->>DB: BEGIN · SELECT wallet FOR UPDATE
    DB-->>I1: balance 100.00 (lock adquirido)
    I2->>DB: BEGIN · SELECT wallet FOR UPDATE
    Note over I2,DB: bloqueada aguardando o lock
    I1->>DB: UPDATE balance=20.00, version=2<br/>INSERT tx PROCESSED, ledger DEBIT, outbox
    I1->>DB: COMMIT (libera lock)
    DB-->>I2: balance 20.00 (lê valor commitado)
    I2->>I2: Wallet.debit(80) → InsufficientFunds
    I2->>DB: INSERT tx REJECTED (INSUFFICIENT_FUNDS) + outbox Rejected
    I2->>DB: COMMIT
    Note over DB: saldo 20.00 · 1 DEBIT · 1 PROCESSED · 1 REJECTED
```

## 8. Sequência — consumo SQS com inbox

```mermaid
sequenceDiagram
    autonumber
    participant Q as wager-transactions.fifo
    participant K as Consumer
    participant U as ProcessWagerTransaction
    participant DB as PostgreSQL
    participant DLQ as DLQ
    K->>Q: ReceiveMessage (long polling)
    Q-->>K: mensagem (messageId, ReceiveCount)
    K->>K: parse + valida schema
    alt malformada / tipo desconhecido
        K->>DLQ: SendMessage
        K->>Q: DeleteMessage
    else válida
        K->>U: execute(command, inbox={consumer, messageId})
        U->>DB: BEGIN
        U->>DB: INSERT inbox ON CONFLICT DO NOTHING
        alt 0 linhas (duplicata)
            U->>DB: ROLLBACK
            K->>Q: DeleteMessage (ack)
        else nova
            U->>DB: lock wallet + aplica + ledger + outbox
            U->>DB: COMMIT
            Note over K: crash aqui → reentrega → inbox detecta
            K->>Q: DeleteMessage (ack só após commit)
        end
    end
    opt erro transitório (DB fora, lock_timeout)
        K->>Q: ChangeMessageVisibility(backoff 2^n)
        Note over Q,DLQ: após maxReceiveCount → redrive para DLQ
    end
```

## 9. Sequência — Transactional Outbox com crash

```mermaid
sequenceDiagram
    autonumber
    participant W1 as Publisher instância 1
    participant DB as PostgreSQL
    participant W2 as Publisher instância 2
    participant EQ as wagering-events.fifo
    W1->>DB: UPDATE outbox SET locked_until=now()+30s<br/>WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
    DB-->>W1: lote [e1, e2]
    W2->>DB: mesmo claim (SKIP LOCKED)
    DB-->>W2: lote [e3] (não vê e1, e2)
    W1->>EQ: SendMessage e1 (DedupId = eventId)
    Note over W1: 💥 processo morre antes de marcar published_at
    W2->>EQ: SendMessage e3
    W2->>DB: UPDATE published_at (e3)
    Note over DB: lease de e1, e2 expira
    W2->>DB: novo claim → [e1, e2]
    W2->>EQ: SendMessage e1 (duplicata segura: dedup por eventId)
    W2->>EQ: SendMessage e2
    W2->>DB: UPDATE published_at (e1, e2)
```

## 10. Sequência — referência fora de ordem

```mermaid
sequenceDiagram
    autonumber
    participant P as Provedor
    participant API as API
    participant DB as PostgreSQL
    participant WK as PendingReferenceWorker
    P->>API: REFUND (ref = bet-1)
    API->>DB: lock wallet · busca ref (provider, bet-1) → não existe
    API->>DB: INSERT tx PENDING_REFERENCE, next_attempt_at · outbox PendingReference
    API-->>P: 202 Accepted
    P->>API: BET bet-1
    API->>DB: aplica BET (DEBIT) · outbox
    API-->>P: 201
    loop a cada tick (backoff exponencial, máx 10 tentativas / 15 min)
        WK->>DB: claim PENDING_REFERENCE vencidas (SKIP LOCKED)
        WK->>DB: lock wallet · resolve ref → BET PROCESSED
        WK->>DB: valida policy · CREDIT · tx PROCESSED · outbox Processed + BalanceChanged
    end
    Note over WK,DB: TTL esgotado sem referência → REJECTED REFERENCE_NOT_FOUND + evento
```

## 11. Decisão — classificação de erro no consumidor

```mermaid
flowchart TD
    E["Erro ao processar mensagem"] --> T{"Tipo"}
    T -- "DomainError (negócio)<br/>ex.: INSUFFICIENT_FUNDS" --> B["Resultado já persistido (REJECTED)<br/>→ DeleteMessage (ack)"]
    T -- "Transitório<br/>DB/SQS fora, lock_timeout,<br/>serialization failure" --> R{"ReceiveCount < 5?"}
    R -- sim --> V["ChangeMessageVisibility<br/>backoff 2^n + jitter"]
    R -- não --> D1["Redrive automático → DLQ"]
    T -- "Permanente<br/>JSON/schema inválido,<br/>type desconhecido" --> D2["SendMessage DLQ + DeleteMessage<br/>métrica dlq_messages_total"]
```

## 12. Fluxo único de reversão (`REFUND` e `ROLLBACK`)

```mermaid
flowchart TD
    R1["REFUND"] --> RT
    R2["ROLLBACK"] --> RT
    RT["ReverseTransaction<br/>(mesmo fluxo, parametrizado por kind)"] --> L["lock wallet → lock referência"]
    L --> F{"referência existe?"}
    F -- não --> PR["PENDING_REFERENCE<br/>auditoria + evento"]
    F -- sim --> K{"kind da referência aceito?<br/>REFUND: BET · ROLLBACK: BET, WIN, REFUND"}
    K -- não --> X1["REJECTED REFERENCE_INVALID_KIND"]
    K -- sim --> V{"mesmo provider, player, wallet,<br/>moeda, rodada e valor?"}
    V -- não --> X2["REJECTED REFERENCE_MISMATCH / AMOUNT_MISMATCH"]
    V -- sim --> A{"já revertida?"}
    A -- sim --> X3["REJECTED REFERENCE_ALREADY_REVERSED<br/>relatedTransactionId = vencedora"]
    A -- não --> S{"saldo suficiente para<br/>o lançamento inverso?"}
    S -- não --> X4["REJECTED REVERSAL_INSUFFICIENT_FUNDS"]
    S -- sim --> OK["PROCESSED + lançamento inverso<br/>auditoria: PROCESSED (reversão) e REVERSED_BY (referência)<br/>outbox: Processed + BalanceChanged"]
    X1 & X2 & X3 & X4 --> AU["auditoria REJECTED + outbox Rejected"]
```

## 13. Linha do tempo de auditoria (exemplo)

```mermaid
sequenceDiagram
    autonumber
    participant P as Provedor
    participant S as Sistema
    participant A as wager_transaction_audit
    P->>S: BET bet-1 (HTTP)
    S->>A: PROCESSED · ledger_entry=L1 (DEBIT 25.00) · instance=app-2
    P->>S: BET bet-1 (reenvio SQS)
    S->>A: IDEMPOTENT_REPLAY · message_id=msg-9 · instance=app-1
    P->>S: BET bet-1 com valor diferente
    S->>A: IDEMPOTENCY_CONFLICT · details={hashEsperado, hashRecebido}
    P->>S: REFUND ref=bet-1
    S->>A: [refund] PROCESSED · ledger_entry=L2 (CREDIT 25.00)
    S->>A: [bet-1] REVERSED_BY · related=refund
    P->>S: ROLLBACK ref=bet-1
    S->>A: [rollback] REJECTED REFERENCE_ALREADY_REVERSED · related=refund
```
