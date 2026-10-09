/**
 * `bun run test:e2e` — E2E da observabilidade (diferencial, docs/06) com Playwright.
 *
 * Sobe o Compose com o perfil `observability` DO ZERO (determinístico: sem alertas já
 * disparados), gera tráfego real e valida pelo navegador:
 * - os dashboards do Grafana renderizam com dados das 3 réplicas;
 * - os alertas provisionados existem;
 * - uma mensagem inválida na fila dispara o alerta "DLQ recebendo" e o e-mail chega ao
 *   Mailpit (o caso que revelou o bug das séries que não nasciam em zero).
 *
 * Requer Docker e Google Chrome (canal `chrome` do Playwright). Capturas em test/e2e/artifacts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type Browser, chromium, type Page } from 'playwright-core';

const ROOT = join(import.meta.dir, '../..');
const ARTIFACTS = join(import.meta.dir, 'artifacts');
const API = 'http://localhost:3000';
const GRAFANA = 'http://localhost:3001';
const MAILPIT = 'http://localhost:8025';
const PROMETHEUS = 'http://localhost:9090';
const GRAFANA_AUTH = { Authorization: `Basic ${btoa('admin:admin')}` };

let browser: Browser;
let page: Page;

async function compose(...args: string[]) {
  const proc = Bun.spawn(['docker', 'compose', '--profile', 'observability', ...args], {
    cwd: ROOT,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`docker compose ${args.join(' ')}:\n${stderr}`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`tempo esgotado esperando: ${what}`);
}

const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
  (await fetch(url, init)).json() as Promise<T>;

interface Targets {
  data: { activeTargets: { labels: { job: string }; health: string }[] };
}
interface PromQuery {
  data: { result: unknown[] };
}
interface MailpitInbox {
  messages: { ID: string; Subject: string }[];
}

beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await compose('down', '-v');
  await compose('up', '-d', '--build', '--wait');
  await waitFor(
    async () => {
      const targets = await json<Targets>(`${PROMETHEUS}/api/v1/targets`);
      const up = targets.data.activeTargets.filter(
        (t) => t.labels.job === 'wagering' && t.health === 'up',
      );
      return up.length === 3 && (await fetch(`${GRAFANA}/api/health`)).ok;
    },
    120_000,
    'Prometheus coletando as 3 réplicas e Grafana pronto',
  );
  browser = await chromium.launch({ channel: 'chrome' });
  // acesso anônimo desligado (só usuários autenticados consultam as fontes de dados)
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  // a interface exige sessão (basic auth vale só para a API): login como um usuário faria
  const login = await page.request.post(`${GRAFANA}/login`, {
    data: { user: 'admin', password: 'admin' },
  });
  expect(login.ok()).toBe(true);
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await compose('down', '-v');
}, 120_000);

async function generateTraffic() {
  const playerId = crypto.randomUUID();
  const wallet = await json<{ id: string }>(`${API}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '50.00', currency: 'BRL' } }),
  });
  for (let i = 0; i < 10; i += 1) {
    await fetch(`${API}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `e2e:${wallet.id}-${i}` },
      body: JSON.stringify({
        providerId: 'e2e',
        externalTransactionId: `${wallet.id}-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: 'r',
        gameId: 'g',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
  }
}

describe('observabilidade pelo navegador (Playwright)', () => {
  it('dashboard Operação: 12 painéis com dados das 3 réplicas', async () => {
    await generateTraffic();
    // o Prometheus coleta a cada 5 s: espera a primeira transação aparecer
    await waitFor(
      async () =>
        (await json<PromQuery>(`${PROMETHEUS}/api/v1/query?query=sum(wagering_transactions_total)`))
          .data.result.length > 0,
      60_000,
      'métricas de transação no Prometheus',
    );

    // o Grafana só renderiza painéis visíveis (lazy): janela alta o bastante para todos
    await page.setViewportSize({ width: 1600, height: 3200 });
    await page.goto(`${GRAFANA}/d/wagering-operacao/x?orgId=1&from=now-15m&to=now&kiosk`);
    const instances = page.getByRole('region', { name: 'Instâncias respondendo' });
    await instances.getByText('3', { exact: true }).waitFor({ timeout: 30_000 });
    for (const title of [
      'Divergências de reconciliação',
      'Outbox lag (máx.)',
      'Transações/s por tipo e status',
      'Latência de processamento',
      'Duplicatas detectadas/s',
      'Erros por failureCode/s',
      'Lock da wallet',
      'Outbox',
      'Fila e retries',
      'Banco (postgres-exporter)',
    ]) {
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
    }
    await page
      .getByRole('region', { name: 'Divergências de reconciliação' })
      .getByText('0', { exact: true })
      .waitFor();
    await page.screenshot({ path: join(ARTIFACTS, 'grafana-operacao.png') });
    await page.setViewportSize({ width: 1600, height: 1000 });
  }, 120_000);

  it('dashboard Auditoria: nenhuma wallet inconsistente', async () => {
    await page.goto(`${GRAFANA}/d/wagering-auditoria/x?orgId=1&from=now-1h&to=now&kiosk`);
    const inconsistent = page.getByRole('region', {
      name: 'Wallets inconsistentes (vazio = saudável)',
    });
    await inconsistent.getByText('No data').waitFor({ timeout: 30_000 });
    await page
      .getByRole('heading', { name: 'Volume creditado e debitado por dia (exato, NUMERIC)' })
      .waitFor();
    await page.screenshot({ path: join(ARTIFACTS, 'grafana-auditoria.png') });
  }, 60_000);

  it('14 alertas provisionados; a regra da DLQ abre no Grafana', async () => {
    const rules = await json<unknown[]>(`${GRAFANA}/api/v1/provisioning/alert-rules`, {
      headers: GRAFANA_AUTH,
    });
    expect(rules).toHaveLength(14);
    await page.goto(`${GRAFANA}/alerting/grafana/dlq-receiving/view`);
    await page.getByText('DLQ recebendo').first().waitFor({ timeout: 45_000 });
  }, 60_000);

  it('a PRIMEIRA mensagem na DLQ dispara o alerta e o e-mail chega ao Mailpit', async () => {
    const sqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo',
        MessageBody: '{"isto não é json',
        MessageGroupId: 'e2e',
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    sqs.destroy();

    let messageId = '';
    await waitFor(
      async () => {
        const inbox = await json<MailpitInbox>(`${MAILPIT}/api/v1/messages`);
        const alert = inbox.messages.find((m) => m.Subject.includes('DLQ recebendo'));
        messageId = alert?.ID ?? '';
        return Boolean(alert);
      },
      180_000,
      'e-mail do alerta "DLQ recebendo" no Mailpit',
    );

    await page.goto(`${MAILPIT}/view/${messageId}`);
    await page.getByText('[FIRING:1] DLQ recebendo medium').first().waitFor();
    // o corpo HTML do e-mail é renderizado num iframe
    await page.frameLocator('iframe').first().getByText('Mensagens na DLQ').waitFor();
    await page.screenshot({ path: join(ARTIFACTS, 'mailpit-alerta-dlq.png') });
  }, 240_000);
});

describe('segurança do Grafana', () => {
  it('sem acesso anônimo: a API de consultas exige autenticação', async () => {
    const res = await fetch(`${GRAFANA}/api/ds/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: [
          { refId: 'A', datasource: { uid: 'wagering-db' }, rawSql: 'SELECT 1', format: 'table' },
        ],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('o usuário do Grafana não lê tabelas fora do necessário (mínimo privilégio)', async () => {
    const res = await fetch(`${GRAFANA}/api/ds/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...GRAFANA_AUTH },
      body: JSON.stringify({
        queries: [
          {
            refId: 'A',
            datasource: { uid: 'wagering-db' },
            rawSql: 'SELECT count(*) FROM inbox_messages',
            format: 'table',
          },
        ],
      }),
    });
    const body = (await res.json()) as { results: { A: { error?: string } } };
    expect(body.results.A.error).toContain('permission denied');
  });
});
