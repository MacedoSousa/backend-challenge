# Relatório de teste de carga

`bun run test:load` executa os cenários de [docs/04 §6](./04-estrategia-testes.md) com o
[k6](https://k6.io) contra o Compose, e no fim **verifica a correção de todas as wallets
tocadas**. Este relatório traz as três rodadas de 2026-10-09: a primeira encontrou um gargalo
na outbox, e as duas seguintes medem as correções.

> **Leia os números como relativos, não absolutos.** Aplicação, Postgres, LocalStack e o
> gerador de carga rodam **na mesma VM** e disputam os mesmos 12 vCPUs. O que este teste
> mostra bem: correção sob carga, a forma das curvas (onde a latência degrada, quanto a
> escala ajuda) e gargalos. Ele não serve como previsão de capacidade em produção.

## 1. Ambiente

| Item | Valor |
|---|---|
| Máquina | VM única: 12 vCPUs, 29 GB de RAM, Ubuntu 26.04.1 LTS (kernel 7.0) |
| Runtime | Bun 1.4.2; Docker 29.8 |
| Banco | PostgreSQL 17.11 (container, configuração padrão) |
| Filas | LocalStack 4 (SQS FIFO emulado; processo Python único) |
| Aplicação | 3 réplicas atrás do balanceador `lb` (nginx); todos os papéis em cada réplica; `DB_POOL_MAX=10` por réplica |
| Gerador | `grafana/k6:1.8.1` em container, na rede do Compose |

## 2. Metodologia

Cada cenário roda contra um Compose limpo (`down -v`) e passa pelas mesmas etapas:
1. `setup`: cria as wallets com saldo alto. O teste mede o caminho de aprovação; as rejeições têm cenários próprios nos testes de integração.
2. Carga do k6 por 60 s (a rampa dura 120 s).
3. Durante a carga, o orquestrador amostra o atraso da outbox direto no banco.
4. Ao fim, coleta `/metrics` de **cada réplica** (as métricas são por instância, ADR-28) e espera a outbox esvaziar.
5. **Verifica a correção** de todas as wallets tocadas: `balance` igual ao último `balance_after` do ledger, cadeia `balance_before → balance_after` contínua e versões sem buracos.

| Cenário | Carga | O que mede |
|---|---|---|
| ST-01 `baseline` | 10 VUs constantes, 200 wallets | latência de referência |
| ST-02 `ramp` | 10 → 200 VUs em 2 min, 200 wallets | onde a latência degrada; atraso da outbox |
| ST-03 `hot` | 50 VUs numa **única** wallet | custo da serialização por wallet (lock pessimista) |
| ST-04 `duplicates` | 20 VUs; 30% das requisições repetem a última operação enviada | custo do replay idempotente |
| ST-08 `scale-1` / `scale-3` | 100 VUs constantes com 1 e com 3 réplicas | ganho da escala horizontal |
| `queue` | 5.000 mensagens na fila de entrada, 100 wallets | vazão do consumidor SQS |

## 3. Resultados (rodada final: código com as duas correções)

| Cenário | Vazão | p50 | p95 | p99 | Erros (5xx/inesperados) | Espera média de lock | Timeouts de lock |
|---|---|---|---|---|---|---|---|
| baseline | 582 req/s | 15 ms | 29 ms | 46 ms | **0** | 1,3 ms | 0 |
| ramp | 713 req/s | 132 ms | 371 ms | 450 ms | **0** | 4,7 ms | 0 |
| hot (1 wallet) | 189 req/s | 202 ms | 487 ms | 588 ms | **0** | 152 ms | **0** |
| duplicates | 795 req/s (30% replays) | 22 ms | 48 ms | 65 ms | **0** | 2,5 ms | 0 |
| scale-1 | 380 req/s | 256 ms | 285 ms | 435 ms | **0** | 2,5 ms | 0 |
| scale-3 | 711 req/s | 133 ms | 246 ms | 320 ms | **0** | 5,1 ms | 0 |
| queue | 326 msg/s (5.000 em 15 s) | — | — | — | 0 na DLQ | — | 0 |

**Correção: 1.101 wallets verificadas ao fim da bateria, 0 inconsistentes, 0 quebras de
cadeia.** As 3 rodadas, ~795 mil requisições somadas, tiveram 0 respostas 5xx e 0
inconsistências.

No cenário `duplicates`, as 14.390 respostas `200` são replays, que devolvem o resultado
original. Não houve nenhum `409`, ou seja, nenhum replay foi confundido com conflito.

## 4. A outbox: o gargalo encontrado e as duas correções

A primeira rodada mostrou o **atraso da outbox** subindo para **74 s** na rampa: eventos
confirmados no banco demoravam mais de um minuto para chegar à fila. A correção financeira
não é afetada, mas consumidores de eventos ficariam muito atrasados.

| Rodada | Mudança | Atraso máx. na rampa | Pendentes (pico) | Vazão de escoamento sem carga* |
|---|---|---|---|---|
| 1 | — (publicação em série, lote de 50) | **74 s** | 108.698 | ~1.600 eventos/s |
| 2 | **lotes em paralelo**: 8 `SendMessageBatch` simultâneos, lote de 100 | 47 s | 73.126 | ~1.800 eventos/s |
| 3 | + **índice certo** para o claim (`(occurred_at, id) WHERE published_at IS NULL`) | 45 s | 63.348 | **~3.200 eventos/s** |

\* Pendentes no pico divididos pelo tempo para zerar depois que a carga para: é a capacidade
real do publicador, sem disputar CPU com a API.

**Correção 1 — lotes em paralelo** (`OUTBOX_PUBLISH_CONCURRENCY`).
- Cada rodada enviava os lotes de 10 mensagens um depois do outro.
- Agora as mensagens são distribuídas em até 8 faixas paralelas. **Todas as mensagens de uma wallet ficam na mesma faixa**, em ordem, para não embaralhar a ordem do grupo FIFO.
- Teste de unidade com SQS falso: paralelismo, ordem por wallet, falha parcial e erro de rede.

**Correção 2 — índice.** `EXPLAIN ANALYZE` com 80 mil eventos pendentes:

| Consulta | Antes | Depois |
|---|---|---|
| claim do lote (`ORDER BY occurred_at, id LIMIT 100 FOR UPDATE SKIP LOCKED`) | 33 ms — ordenava os 80 mil em disco | **2,8 ms** — percorre o índice já ordenado |
| atraso (`min(occurred_at) WHERE published_at IS NULL`) | 49 ms — varredura sequencial da tabela **inteira**, crescendo com o histórico | **0,05 ms** |

O índice antigo era por `next_attempt_at`, que não serve à ordenação do claim. A consulta de
atraso também é usada pelos alertas "Outbox atrasada" e "Outbox parada" do Grafana, que
ficaram baratos.

**O que sobrou, e por quê.** Mesmo com o publicador escoando ~3.200 eventos/s quando a carga
para, o atraso ainda chega a ~45 s **durante** a rampa. A causa é disputa de recursos, não o
publicador:
- Cada réplica Bun tem **um único event loop**, dividido entre a API (saturada a ~700 req/s, com 2 eventos por transação) e o publicador.
- Os 12 vCPUs também atendem o Postgres, o LocalStack e o k6.
- Isso aparece no trade-off entre rodadas: a vazão da API na rampa caiu de 812 para 713 req/s enquanto o publicador passou a usar mais CPU.

Em produção, o desenho já resolve isso: o papel `outbox` roda em instâncias **dedicadas**
(`APP_ROLE=outbox`), sem disputar o event loop com a API, e o SQS real não divide CPU com a
aplicação. Os alertas "Outbox atrasada" (30 s) e "Outbox parada" (5 min) avisam se o atraso
crescer.

## 5. Análise

**Escala horizontal (ST-08).**
- De 1 para 3 réplicas: **380 → 711 req/s (1,9×)**; p95 de 285 → 246 ms e p99 de 435 → 320 ms.
- Não chega a 3×, porque todas as réplicas e o Postgres disputam a mesma VM. Em máquinas separadas, o teto passaria a ser o Postgres primário (ARCHITECTURE, Escalabilidade).
- A correção com 3 réplicas não depende de carga: está provada em CT-04 e CT-08 com processos reais.

**Hot wallet (ST-03).**
- 50 VUs numa só wallet: **~189 req/s, todas aplicadas, 0 timeouts de lock** (`lock_timeout` = 5 s).
- Esse é o teto de uma wallet: as operações são serializadas pelo `FOR UPDATE`, e cada uma espera em média 152 ms na fila do lock. O p99 de 588 ms da resposta limita por cima o p99 dessa espera.
- É o custo aceito no ADR-03: no pessimista o conflito vira fila ordenada, sem trabalho desperdiçado. No otimista, o mesmo cenário viraria uma tempestade de retries.
- Se o lock estourasse, o provedor receberia `503 INFRA_UNAVAILABLE` com `Retry-After: 1`, e o reenvio com a mesma `Idempotency-Key` é seguro (`failure-paths.spec.ts`).

**Conflitos de lock nos outros cenários.**
- Dezenas de milhares de esperas registradas, mas com média de 1–5 ms.
- Com 200 wallets e até 200 VUs, várias requisições caem na mesma wallet, mas a seção crítica é curta.

**Replay idempotente (ST-04).**
- O replay é **mais barato** que uma decisão nova: o cenário com 30% de replays teve a maior vazão (795 req/s) e p95 de 48 ms.
- O replay devolve o resultado gravado sem tocar no ledger.

**Fila (queue).**
- 5.000 mensagens consumidas em 15 s (~326 msg/s) com 3 consumidores, 0 na DLQ e todas as wallets consistentes.
- O teto aqui é o LocalStack, que é um processo Python único.

**Ruído.**
- O baseline variou entre 582 e 681 req/s nas rodadas, com o mesmo código no caminho da API.
- Variações de ~15% entre rodadas são ruído da VM compartilhada e não devem ser lidas como regressão.

## 6. Como reproduzir

```bash
bun run test:load            # todos os cenários (~15 min); resultados em test/load/results/
```

O orquestrador (`test/load/run.ts`) sobe e derruba o Compose sozinho. Requisitos: Docker e a
porta 3000 livre. Os resultados brutos (JSON por cenário e o consolidado) ficam em
`test/load/results/`, que não é versionado.
