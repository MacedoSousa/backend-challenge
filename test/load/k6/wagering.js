// Cenários de carga (docs/04 §6). Executado pelo orquestrador test/load/run.ts via
// `grafana/k6` em container, dentro da rede do Compose (alvo: o balanceador `lb`).
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE = __ENV.TARGET || 'http://lb';
const SCENARIO = __ENV.SCENARIO || 'baseline';
const WALLETS = Number(__ENV.WALLETS || 200);

/** Um contador por desfecho HTTP: a taxa de erro real separa negócio (422) de falha (5xx). */
const outcomes = {
  201: new Counter('status_201_processed'),
  200: new Counter('status_200_replay'),
  202: new Counter('status_202_pending'),
  409: new Counter('status_409_conflict'),
  422: new Counter('status_422_rejected'),
  503: new Counter('status_503_unavailable'),
};
const unexpected = new Counter('status_unexpected');

const SCENARIOS = {
  // ST-01: carga leve e estável, wallets distribuídas — latência de referência
  baseline: { executor: 'constant-vus', vus: 10, duration: '60s' },
  // ST-02: rampa até 200 VUs — onde a latência começa a degradar
  ramp: {
    executor: 'ramping-vus',
    startVUs: 10,
    stages: [
      { duration: '30s', target: 50 },
      { duration: '30s', target: 100 },
      { duration: '30s', target: 200 },
      { duration: '30s', target: 200 },
    ],
  },
  // ST-03: 50 VUs disputando UMA wallet — custo da serialização por wallet
  hot: { executor: 'constant-vus', vus: 50, duration: '60s' },
  // ST-04: 30% das requisições repetem uma operação já enviada — custo do replay
  duplicates: { executor: 'constant-vus', vus: 20, duration: '60s' },
  // ST-08: carga fixa alta, rodada com 1 e com 3 réplicas para comparar
  scale: { executor: 'constant-vus', vus: 100, duration: '60s' },
};

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    // falhas de infraestrutura (5xx/inesperados) devem ser raras; 4xx de negócio são esperados
    status_unexpected: ['count<1'],
  },
  setupTimeout: '120s',
};

const headers = { 'content-type': 'application/json' };

/** Última operação enviada por VU: o replay do ST-04 a repete exatamente. */
const lastSent = {};

function uuid() {
  // UUID v4 suficiente para ids de jogador nos testes
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function setup() {
  const count = SCENARIO === 'hot' ? 1 : WALLETS;
  // saldo alto: a carga mede o caminho de aprovação; rejeições vêm de cenários próprios
  const balance = SCENARIO === 'hot' ? '100000000.00' : '1000000.00';
  const wallets = [];
  for (let i = 0; i < count; i += 1) {
    const playerId = uuid();
    const res = http.post(
      `${BASE}/wallets`,
      JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
      { headers },
    );
    if (res.status !== 201) throw new Error(`setup falhou: ${res.status} ${res.body}`);
    wallets.push({ walletId: res.json('id'), playerId });
  }
  return { wallets, run: uuid().slice(0, 8) };
}

export default function (data) {
  const wallet = data.wallets[Math.floor(Math.random() * data.wallets.length)];
  const vu = exec.vu.idInTest;
  const iteration = exec.vu.iterationInScenario;

  // ST-04: 30% das iterações reenviam, por inteiro, a ÚLTIMA operação de fato enviada por
  // este VU (mesmo id, rodada e wallet) — a taxa real de replay é a configurada
  const replay = SCENARIO === 'duplicates' && lastSent[vu] !== undefined && Math.random() < 0.3;
  const body = replay
    ? lastSent[vu]
    : {
        providerId: 'load',
        externalTransactionId: `${data.run}-${vu}-${iteration}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: `round-${iteration % 50}`,
        gameId: `game-${vu % 10}`,
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      };
  if (!replay) lastSent[vu] = body;

  const res = http.post(`${BASE}/wagering/transactions`, JSON.stringify(body), {
    headers: { ...headers, 'idempotency-key': `load:${body.externalTransactionId}` },
    tags: { name: 'POST /wagering/transactions' },
  });

  const counter = outcomes[res.status];
  if (counter) counter.add(1);
  else unexpected.add(1);
  check(res, {
    'resposta esperada (2xx/409/422)': (r) => [200, 201, 202, 409, 422].includes(r.status),
  });
}
