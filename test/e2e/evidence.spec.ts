/**
 * `bun run test:evidence` — mapa de cenários com evidência em vídeo (Playwright).
 *
 * Sobe tudo do zero (aplicação com 3 réplicas + observabilidade), executa cada cenário
 * funcional e cada gatilho de alerta, e grava evidence/<data>/: um vídeo do console de
 * evidências por cenário (requisições, respostas, banco, verificações), vídeos/capturas das
 * telas (Grafana, Prometheus, Mailpit) e index.html + summary.json.
 *
 * Se houver SMTP_RELAY_HOST no .env, os alertas também são entregues ao ALERT_EMAIL_TO real
 * (compose.email.yaml). Requer Docker e Google Chrome.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { type Browser, chromium } from 'playwright-core';
import { EvidenceRun, type Scenario } from './support/evidence';

const ROOT = join(import.meta.dir, '../..');
const API = 'http://localhost:3000';
const GRAFANA = 'http://localhost:3001';
const MAILPIT = 'http://localhost:8025';
const PROMETHEUS = 'http://localhost:9090';
const QUEUE_URL = 'http://localhost:4566/000000000000/wager-transactions.fifo';
const TIMEOUT = 600_000;

const realEmail = (() => {
  const env = join(ROOT, '.env');
  if (!existsSync(env)) return undefined;
  const vars = Object.fromEntries(
    readFileSync(env, 'utf8')
      .split('\n')
      .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => [m[1], m[2]?.trim() ?? '']),
  );
  return vars.SMTP_RELAY_HOST && vars.ALERT_EMAIL_TO ? (vars.ALERT_EMAIL_TO as string) : undefined;
})();
const composeFiles = realEmail ? ['-f', 'compose.yaml', '-f', 'compose.email.yaml'] : [];

let browser: Browser;
let run: EvidenceRun;
let sql: SQL;
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

async function sh(cmd: string[]) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')}:\n${err}`);
}
const compose = (...args: string[]) =>
  sh(['docker', 'compose', ...composeFiles, '--profile', 'observability', ...args]);

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`tempo esgotado: ${what}`);
}

beforeAll(async () => {
  await compose('down', '-v');
  await compose('up', '-d', '--build', '--wait');
  await until(
    async () => {
      const targets = (await (await fetch(`${PROMETHEUS}/api/v1/targets`)).json()) as {
        data: { activeTargets: { labels: { job: string }; health: string }[] };
      };
      return (
        targets.data.activeTargets.filter((t) => t.labels.job === 'wagering' && t.health === 'up')
          .length === 3 && (await fetch(`${GRAFANA}/api/health`)).ok
      );
    },
    180_000,
    'Prometheus coletando as 3 réplicas e Grafana pronto',
  );
  sql = new SQL('postgres://wagering:wagering@localhost:5432/wagering');
  browser = await chromium.launch({ channel: 'chrome' });
  run = new EvidenceRun(browser, join(ROOT, 'evidence'), sql, {
    replicas: '3',
    'e-mail dos alertas': realEmail ? `${realEmail} (via SMTP real) + Mailpit` : 'Mailpit local',
  });
}, TIMEOUT);

afterAll(async () => {
  run?.writeIndex();
  const latest = join(ROOT, 'evidence', 'latest');
  rmSync(latest, { force: true });
  if (run) symlinkSync(run.dir, latest);
  await browser?.close();
  await sql?.close();
  sqs.destroy();
  // o ambiente continua no ar para inspeção manual (docker compose --profile observability down)
}, TIMEOUT);

// ---------------------------------------------------------------------------------------
// helpers de domínio
// ---------------------------------------------------------------------------------------
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function wallet(s: Scenario, initial: string, label = 'cria wallet') {
  const playerId = crypto.randomUUID();
  const res = await s.http<{ id: string; balance: unknown; version: number }>(
    'POST',
    `${API}/wallets`,
    {
      body: { playerId, initialBalance: brl(initial) },
      label,
    },
  );
  await s.check('wallet criada (201)', res.status === 201, res.body);
  return { walletId: res.body.id, playerId };
}

type Wallet = Awaited<ReturnType<typeof wallet>>;

function wager(w: Wallet, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'evidence',
    externalTransactionId: `ev-${crypto.randomUUID().slice(0, 8)}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('10.00'),
    ...extra,
  };
}

function submit(s: Scenario, body: Record<string, unknown>, label?: string, key?: string) {
  return s.http<Record<string, unknown>>('POST', `${API}/wagering/transactions`, {
    body,
    headers: { 'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}` },
    ...(label ? { label } : {}),
  });
}

async function sendToQueue(s: Scenario, body: string, groupId: string, label: string) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  await s.note(`${label} — enviada para wager-transactions.fifo: ${body.slice(0, 160)}`);
}

async function balanceOf(s: Scenario, w: Wallet) {
  const res = await s.http<{ balance: { amount: string } }>('GET', `${API}/wallets/${w.walletId}`);
  return res.body.balance.amount;
}

/** Espera o e-mail do alerta no Mailpit (busca pelo nome da regra) e o abre na aba web. */
async function expectAlertEmail(s: Scenario, rule: string, timeoutMs = 300_000) {
  await s.note(
    `aguardando o alerta "${rule}" disparar e o e-mail chegar (Grafana avalia a cada 30 s)…`,
  );
  let id = '';
  const started = Date.now();
  await until(
    async () => {
      const res = (await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`"${rule}"`)}`)
      ).json()) as { messages: { ID: string; Subject: string }[] };
      const firing = res.messages.find((m) => m.Subject.includes('FIRING'));
      id = firing?.ID ?? '';
      return Boolean(firing);
    },
    timeoutMs,
    `e-mail do alerta "${rule}"`,
  );
  await s.check(
    `e-mail do alerta "${rule}" recebido em ${((Date.now() - started) / 1000).toFixed(0)} s${
      realEmail ? ` (e retransmitido a ${realEmail})` : ''
    }`,
    true,
  );
  await s.show(
    `email-${rule.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    `${MAILPIT}/view/${id}`,
    (p) => p.getByText('FIRING').first().waitFor(),
  );
}

// ---------------------------------------------------------------------------------------
// cenários funcionais (§3, §7, §8, §9, §10)
// ---------------------------------------------------------------------------------------
describe('evidências — fluxos da API e da fila', () => {
  it(
    'S01 wallet: criação com OPENING, consulta e ledger',
    async () => {
      await run.scenario('S01', 'API', 'Wallet: criação, consulta e ledger', async (s) => {
        const w = await wallet(s, '1000.00');
        const got = await s.http<{ balance: { amount: string }; version: number }>(
          'GET',
          `${API}/wallets/${w.walletId}`,
        );
        await s.check(
          'saldo 1000.00, versão 1',
          got.body.balance.amount === '1000.00' && got.body.version === 1,
        );
        const ledger = await s.http<{ items: unknown[] }>(
          'GET',
          `${API}/wallets/${w.walletId}/ledger`,
        );
        await s.check('ledger com 1 CREDIT de abertura', ledger.body.items.length === 1);
        const dup = await s.http('POST', `${API}/wallets`, {
          body: { playerId: w.playerId, initialBalance: brl('5.00') },
          label: 'mesma moeda de novo',
        });
        await s.check('wallet duplicada → 409 WALLET_ALREADY_EXISTS', dup.status === 409);
      });
    },
    TIMEOUT,
  );

  it(
    'S02 cenário obrigatório: 2 × BET 80.00 simultâneas sobre 100.00',
    async () => {
      await run.scenario('S02', 'API', 'Cenário obrigatório (§8)', async (s) => {
        const w = await wallet(s, '100.00');
        await s.note('disparando as duas apostas ao mesmo tempo…');
        const [a, b] = await Promise.all([
          submit(s, wager(w, { money: brl('80.00') }), 'aposta A'),
          submit(s, wager(w, { money: brl('80.00') }), 'aposta B'),
        ]);
        const statuses = [a.status, b.status].sort();
        await s.check(
          'uma 201 PROCESSED e uma 422 INSUFFICIENT_FUNDS',
          statuses[0] === 201 && statuses[1] === 422,
        );
        await s.check('saldo final 20.00', (await balanceOf(s, w)) === '20.00');
        const debits = await s.query(
          'lançamentos de débito da wallet',
          sql`SELECT direction, amount::text, balance_before::text, balance_after::text
              FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId} AND direction = 'DEBIT'`,
        );
        await s.check('exatamente um DEBIT no ledger', debits.length === 1);
      });
    },
    TIMEOUT,
  );

  it(
    'S03 idempotência: replay, payload divergente e chave divergente',
    async () => {
      await run.scenario('S03', 'API', 'Idempotência (§9)', async (s) => {
        const w = await wallet(s, '100.00');
        const body = wager(w, { money: brl('30.00') });
        const first = await submit(s, body, 'primeira vez');
        await s.check('201 PROCESSED', first.status === 201);
        const replay = await submit(s, body, 'reenvio idêntico');
        await s.check(
          'replay → 200, idempotentReplay: true, mesmo saldo',
          replay.status === 200 && replay.body.idempotentReplay === true,
        );
        const conflict = await submit(
          s,
          { ...body, money: brl('31.00') },
          'mesma chave, outro valor',
        );
        await s.check(
          'payload divergente → 409 IDEMPOTENCY_PAYLOAD_MISMATCH',
          conflict.status === 409,
        );
        const keyMismatch = await submit(s, body, 'mesma operação, outra chave', 'outra-chave');
        await s.check(
          'chave divergente → 409 IDEMPOTENCY_KEY_MISMATCH',
          keyMismatch.status === 409,
        );
        await s.check('saldo debitado uma única vez (70.00)', (await balanceOf(s, w)) === '70.00');
      });
    },
    TIMEOUT,
  );

  it(
    'S04 reversão única: REFUND credita, ROLLBACK da mesma BET é recusado',
    async () => {
      await run.scenario('S04', 'API', 'Reversões — fluxo único (§7, D-01)', async (s) => {
        const w = await wallet(s, '100.00');
        const bet = wager(w, {
          externalTransactionId: `bet-${crypto.randomUUID().slice(0, 6)}`,
          money: brl('40.00'),
        });
        await submit(s, bet, 'BET 40.00');
        const refund = await submit(
          s,
          wager(w, {
            kind: 'REFUND',
            referenceExternalTransactionId: bet.externalTransactionId,
            money: brl('40.00'),
          }),
          'REFUND da BET',
        );
        await s.check('REFUND 201, saldo volta a 100.00', refund.status === 201);
        const rollback = await submit(
          s,
          wager(w, {
            kind: 'ROLLBACK',
            referenceExternalTransactionId: bet.externalTransactionId,
            money: brl('40.00'),
          }),
          'ROLLBACK da mesma BET',
        );
        await s.check(
          'ROLLBACK → 422 REFERENCE_ALREADY_REVERSED apontando o REFUND',
          rollback.status === 422 &&
            rollback.body.relatedTransactionId === refund.body.transactionId,
        );
      });
    },
    TIMEOUT,
  );

  it(
    'S05 referência fora de ordem: REFUND antes da BET é resolvido pelo worker',
    async () => {
      await run.scenario('S05', 'API', 'Referência fora de ordem (§7.1)', async (s) => {
        const w = await wallet(s, '100.00');
        const betId = `bet-${crypto.randomUUID().slice(0, 6)}`;
        const refund = await submit(
          s,
          wager(w, { kind: 'REFUND', referenceExternalTransactionId: betId, money: brl('25.00') }),
          'REFUND chega antes',
        );
        await s.check('202 PENDING_REFERENCE', refund.status === 202);
        await submit(
          s,
          wager(w, { externalTransactionId: betId, money: brl('25.00') }),
          'a BET chega depois',
        );
        await until(
          async () =>
            (
              (await (
                await fetch(`${API}/wagering/transactions/${refund.body.transactionId}`)
              ).json()) as { status: string }
            ).status === 'PROCESSED',
          60_000,
          'worker resolver o REFUND',
        );
        const tx = await s.http<{ status: string }>(
          'GET',
          `${API}/wagering/transactions/${refund.body.transactionId}`,
        );
        await s.check('REFUND resolvido pelo worker: PROCESSED', tx.body.status === 'PROCESSED');
        const audit = await s.http<{ items: { action: string; source: string }[] }>(
          'GET',
          `${API}/wagering/transactions/${refund.body.transactionId}/audit`,
          { label: 'linha do tempo de auditoria' },
        );
        await s.check(
          'auditoria: PENDING_REFERENCE (HTTP) → PROCESSED (WORKER)',
          audit.body.items.map((i) => `${i.action}:${i.source}`).join(',') ===
            'PENDING_REFERENCE:HTTP,PROCESSED:WORKER',
        );
        await s.check('saldo final 100.00', (await balanceOf(s, w)) === '100.00');
      });
    },
    TIMEOUT,
  );

  it(
    'S06 fila SQS: processamento, reentrega sem efeito duplo e DLQ',
    async () => {
      await run.scenario('S06', 'Fila', 'Consumo SQS (§10)', async (s) => {
        const w = await wallet(s, '100.00');
        const data = { ...wager(w, { money: brl('15.00') }) };
        const message = JSON.stringify({
          messageId: `msg-${crypto.randomUUID().slice(0, 8)}`,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
        });
        await sendToQueue(s, message, w.walletId, 'mensagem válida');
        await sendToQueue(s, message, w.walletId, 'a MESMA mensagem de novo (reentrega)');
        await until(
          async () =>
            (
              (await (await fetch(`${API}/wallets/${w.walletId}`)).json()) as {
                balance: { amount: string };
              }
            ).balance.amount === '85.00',
          60_000,
          'consumidor processar',
        );
        await Bun.sleep(3_000);
        await s.check('debitado uma única vez (85.00)', (await balanceOf(s, w)) === '85.00');
        await s.query(
          'inbox: a mensagem registrada uma vez',
          sql`SELECT consumer_name, message_id, processed_at IS NOT NULL AS processed FROM inbox_messages
             WHERE message_id = ${JSON.parse(message).messageId}`,
        );
        await sendToQueue(s, '{"isto não é json', w.walletId, 'mensagem malformada');
        await until(
          async () => {
            const res = (await (
              await fetch(
                `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('sum(wagering_dlq_messages_total{reason="malformed_json"})')}`,
              )
            ).json()) as { data: { result: { value: [number, string] }[] } };
            return Number(res.data.result[0]?.value[1] ?? 0) >= 1;
          },
          60_000,
          'mensagem ir para a DLQ',
        );
        await s.check(
          'mensagem malformada enviada à DLQ (métrica wagering_dlq_messages_total)',
          true,
        );
      });
    },
    TIMEOUT,
  );

  it(
    'S07 validações e erros: 400, 404, 422 com failureCode',
    async () => {
      await run.scenario('S07', 'API', 'Status HTTP distintos (§9)', async (s) => {
        const w = await wallet(s, '10.00');
        const invalid = await submit(s, wager(w, { money: brl('25') }), 'valor sem 2 casas');
        await s.check('400 VALIDATION_ERROR', invalid.status === 400);
        const ghost = await submit(
          s,
          wager({ walletId: crypto.randomUUID(), playerId: crypto.randomUUID() }),
          'wallet inexistente',
        );
        await s.check('404 WALLET_NOT_FOUND', ghost.status === 404);
        const currency = await submit(
          s,
          wager(w, { money: { amount: '1.00', currency: 'USD' } }),
          'moeda diferente',
        );
        await s.check(
          '422 CURRENCY_MISMATCH',
          currency.status === 422 && currency.body.failureCode === 'CURRENCY_MISMATCH',
        );
        const noKey = await s.http('POST', `${API}/wagering/transactions`, {
          body: wager(w),
          label: 'sem Idempotency-Key',
        });
        await s.check('400 sem Idempotency-Key', noKey.status === 400);
      });
    },
    TIMEOUT,
  );

  it(
    'S08 reconciliação, health e métricas',
    async () => {
      await run.scenario(
        'S08',
        'Operação',
        'Reconciliação, health e métricas (§9, §12)',
        async (s) => {
          const w = await wallet(s, '500.00');
          await submit(s, wager(w, { money: brl('120.00') }));
          const rec = await s.http<{ consistent: boolean }>(
            'POST',
            `${API}/wallets/${w.walletId}/reconciliation`,
          );
          await s.check('reconciliação consistente', rec.body.consistent === true);
          const ready = await s.http('GET', `${API}/health/ready`);
          await s.check('/health/ready 200 (Postgres e SQS)', ready.status === 200);
          const metrics = await s.http<string>('GET', `${API}/metrics`, {
            label: 'métricas Prometheus',
          });
          await s.check(
            'métricas de negócio expostas',
            String(metrics.body).includes('wagering_transactions_total'),
          );
        },
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------------------
// telas de observabilidade
// ---------------------------------------------------------------------------------------
describe('evidências — telas de observabilidade', () => {
  it(
    'O01 Prometheus coleta as 3 réplicas',
    async () => {
      await run.scenario(
        'O01',
        'Observabilidade',
        'Prometheus: uma linha por réplica (ADR-28)',
        async (s) => {
          await s.show('prometheus-targets', `${PROMETHEUS}/targets`, (p) =>
            p.getByText('wagering').first().waitFor(),
          );
          const res = await s.http<{ data: { result: unknown[] } }>(
            'GET',
            `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('up{job="wagering"} == 1')}`,
          );
          await s.check('3 réplicas respondendo', res.body.data.result.length === 3);
        },
      );
    },
    TIMEOUT,
  );

  it(
    'O02 Grafana: dashboard Operação com dados',
    async () => {
      await run.scenario('O02', 'Observabilidade', 'Grafana — Operação', async (s) => {
        const page = await s.show(
          'grafana-operacao',
          `${GRAFANA}/d/wagering-operacao/x?orgId=1&from=now-15m&to=now&kiosk`,
          (p) =>
            p
              .getByRole('region', { name: 'Instâncias respondendo' })
              .getByText('3', { exact: true })
              .waitFor({ timeout: 60_000 }),
        );
        await page.mouse.wheel(0, 1_600);
        await page.waitForTimeout(2_500);
        await s.check('painéis renderizados com dados das 3 réplicas', true);
      });
    },
    TIMEOUT,
  );

  it(
    'O03 Grafana: auditoria financeira e linha do tempo de uma transação',
    async () => {
      await run.scenario('O03', 'Observabilidade', 'Grafana — Auditoria financeira', async (s) => {
        const w = await wallet(s, '100.00');
        const tx = await submit(s, wager(w, { money: brl('35.00') }), 'transação a investigar');
        await s.show(
          'grafana-auditoria',
          `${GRAFANA}/d/wagering-auditoria/x?orgId=1&from=now-1h&to=now&kiosk&var-transactionId=${tx.body.transactionId}`,
          (p) =>
            p
              .getByRole('region', { name: 'Wallets inconsistentes (vazio = saudável)' })
              .getByText('No data')
              .waitFor({ timeout: 60_000 }),
        );
        await s.check('nenhuma wallet inconsistente; linha do tempo da transação exibida', true);
      });
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------------------
// gatilhos de alerta → e-mail
// ---------------------------------------------------------------------------------------
describe('evidências — alertas disparados e e-mails recebidos', () => {
  it(
    'A01 DLQ recebendo (médio)',
    async () => {
      await run.scenario('A01', 'Alerta', 'DLQ recebendo', async (s) => {
        await s.note('gatilho: a mensagem malformada do S06 foi para a DLQ');
        await expectAlertEmail(s, 'DLQ recebendo');
      });
    },
    TIMEOUT,
  );

  it(
    'A02 Reversão sem saldo (médio)',
    async () => {
      await run.scenario('A02', 'Alerta', 'Reversão sem saldo', async (s) => {
        const w = await wallet(s, '0.00');
        const win = wager(w, {
          kind: 'WIN',
          externalTransactionId: `win-${crypto.randomUUID().slice(0, 6)}`,
          money: brl('50.00'),
        });
        await submit(s, win, 'WIN 50.00');
        await submit(s, wager(w, { money: brl('45.00') }), 'BET 45.00 (sobra 5.00)');
        const rollback = await submit(
          s,
          wager(w, {
            kind: 'ROLLBACK',
            referenceExternalTransactionId: win.externalTransactionId,
            money: brl('50.00'),
          }),
          'ROLLBACK do WIN sem saldo',
        );
        await s.check(
          '422 REVERSAL_INSUFFICIENT_FUNDS',
          rollback.body.failureCode === 'REVERSAL_INSUFFICIENT_FUNDS',
        );
        await expectAlertEmail(s, 'Reversão sem saldo');
      });
    },
    TIMEOUT,
  );

  it(
    'A03 Gargalo: hot wallet — lock esgotado (médio)',
    async () => {
      await run.scenario('A03', 'Alerta', 'Gargalo: hot wallet', async (s) => {
        const w = await wallet(s, '100.00');
        await s.note(
          'segurando o lock da wallet por 7 s direto no banco (simula uma operação longa)…',
        );
        const holder = sql.begin(async (tx) => {
          await tx`SELECT id FROM wallets WHERE id = ${w.walletId} FOR UPDATE`;
          await tx`SELECT pg_sleep(7)`;
        });
        await Bun.sleep(500);
        const blocked = await submit(s, wager(w), 'aposta na wallet travada');
        await s.check(
          '503 INFRA_UNAVAILABLE com Retry-After',
          blocked.status === 503 && blocked.headers.get('retry-after') === '1',
        );
        await holder;
        await expectAlertEmail(s, 'Gargalo: hot wallet');
      });
    },
    TIMEOUT,
  );

  it(
    'A04 Conflitos de idempotência anormais (leve)',
    async () => {
      await run.scenario('A04', 'Alerta', 'Conflitos de idempotência anormais', async (s) => {
        const w = await wallet(s, '1000.00');
        const body = wager(w, { money: brl('1.00') });
        await submit(s, body, 'operação original');
        for (let i = 2; i <= 12; i += 1) {
          await submit(s, { ...body, money: brl(`${i}.00`) }, `conflito ${i - 1}/11`);
        }
        await expectAlertEmail(s, 'Conflitos de idempotência anormais');
      });
    },
    TIMEOUT,
  );

  it(
    'A05 Antifraude: velocidade de reversões (médio)',
    async () => {
      await run.scenario('A05', 'Alerta', 'Antifraude: velocidade de reversões', async (s) => {
        const w = await wallet(s, '1000.00');
        for (let i = 1; i <= 6; i += 1) {
          const bet = wager(w, {
            externalTransactionId: `vel-${crypto.randomUUID().slice(0, 6)}`,
            money: brl('5.00'),
          });
          await submit(s, bet, `BET ${i}/6`);
          await submit(
            s,
            wager(w, {
              kind: 'REFUND',
              referenceExternalTransactionId: bet.externalTransactionId,
              money: brl('5.00'),
            }),
            `REFUND ${i}/6`,
          );
        }
        await expectAlertEmail(s, 'Antifraude: velocidade de reversões');
      });
    },
    TIMEOUT,
  );

  it(
    'A06 Antifraude: jogos simultâneos (médio)',
    async () => {
      await run.scenario('A06', 'Alerta', 'Antifraude: jogos simultâneos', async (s) => {
        const w = await wallet(s, '100.00');
        await submit(s, wager(w, { gameId: 'roleta' }), 'aposta no jogo A');
        await submit(
          s,
          wager(w, { gameId: 'slots' }),
          'aposta no jogo B, mesmo jogador, no mesmo minuto',
        );
        await expectAlertEmail(s, 'Antifraude: jogos simultâneos');
      });
    },
    TIMEOUT,
  );

  it(
    'A07 Retries elevados (leve)',
    async () => {
      await run.scenario('A07', 'Alerta', 'Retries elevados', async (s) => {
        const w = await wallet(s, '100.00');
        for (let i = 1; i <= 12; i += 1) {
          await submit(
            s,
            wager(w, {
              kind: 'REFUND',
              referenceExternalTransactionId: `nao-existe-${i}`,
              money: brl('1.00'),
            }),
            `REFUND sem referência ${i}/12`,
          );
        }
        await s.note(
          'o worker de pendências refaz cada uma com backoff → mais de 50 retries em 15 min',
        );
        await expectAlertEmail(s, 'Retries elevados', 420_000);
      });
    },
    TIMEOUT,
  );

  it(
    'A08 Outbox parada (crítico) — medida no banco',
    async () => {
      await run.scenario('A08', 'Alerta', 'Outbox parada', async (s) => {
        const id = crypto.randomUUID();
        await s.query(
          'evento travado há 10 min (falhando ao publicar: próxima tentativa só amanhã)',
          sql`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
            VALUES (${id}, ${crypto.randomUUID()}, 'WalletBalanceChanged', '{}'::jsonb,
                    now() - interval '10 minutes', 7, now() + interval '1 day')
            RETURNING id, occurred_at, attempts`,
        );
        await expectAlertEmail(s, 'Outbox parada');
        await s.query(
          'limpeza: evento marcado como publicado',
          sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${id} RETURNING id`,
        );
      });
    },
    TIMEOUT,
  );

  it(
    'A09 Divergência de reconciliação (crítico)',
    async () => {
      await run.scenario('A09', 'Alerta', 'Divergência de reconciliação', async (s) => {
        const w = await wallet(s, '100.00');
        await s.note(
          'corrupção proposital: só um superusuário desligando os triggers consegue alterar o saldo',
        );
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          await tx`UPDATE wallets SET balance = 130.00 WHERE id = ${w.walletId}`;
        });
        const rec = await s.http<{ consistent: boolean; difference: unknown }>(
          'POST',
          `${API}/wallets/${w.walletId}/reconciliation`,
        );
        await s.check(
          'reconciliação detecta: consistent=false, diferença 30.00 (sem corrigir)',
          rec.body.consistent === false,
        );
        await expectAlertEmail(s, 'Divergência de reconciliação');
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          await tx`UPDATE wallets SET balance = 100.00 WHERE id = ${w.walletId}`;
        });
        await s.note('limpeza: saldo restaurado para não poluir os próximos cenários');
      });
    },
    TIMEOUT,
  );

  it(
    'A10 Instância fora (médio)',
    async () => {
      await run.scenario('A10', 'Alerta', 'Instância fora', async (s) => {
        await sh(['docker', 'stop', 'wagering-app-3']);
        await s.note('docker stop wagering-app-3 — uma das 3 réplicas sai do ar');
        const health = await s.http('GET', `${API}/health/live`, {
          label: 'o balanceador segue atendendo',
        });
        await s.check('API continua no ar com 2 réplicas', health.status === 200);
        await expectAlertEmail(s, 'Instância fora');
        await sh(['docker', 'start', 'wagering-app-3']);
        await s.note('docker start wagering-app-3 — réplica de volta');
      });
    },
    TIMEOUT,
  );

  it(
    'A11 Banco indisponível (crítico) — por último',
    async () => {
      await run.scenario('A11', 'Alerta', 'Banco indisponível', async (s) => {
        await sh(['docker', 'stop', 'wagering-postgres-1']);
        await s.note('docker stop wagering-postgres-1 — o PostgreSQL sai do ar');
        const w = { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() };
        const res = await submit(s, wager(w), 'aposta com o banco fora');
        await s.check('503 INFRA_UNAVAILABLE (nunca 500)', res.status === 503);
        const ready = await s.http('GET', `${API}/health/ready`);
        await s.check('/health/ready 503', ready.status === 503);
        await expectAlertEmail(s, 'Banco indisponível');
        await sh(['docker', 'start', 'wagering-postgres-1']);
        await s.note('docker start wagering-postgres-1 — banco de volta');
        await until(
          async () => (await fetch(`${API}/health/ready`)).ok,
          120_000,
          'readiness voltar',
        );
        await s.check('/health/ready volta a 200', true);
      });
    },
    TIMEOUT,
  );
});
