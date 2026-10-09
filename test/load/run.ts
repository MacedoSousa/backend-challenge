/**
 * `bun run test:load` — teste de carga (diferencial do §14, docs/04 §6).
 *
 * Sobe o Compose (balanceador + N réplicas), roda cada cenário k6 em container, mede o
 * outbox lag durante a carga, coleta as métricas de cada réplica e, ao final, VERIFICA A
 * CORREÇÃO (saldo × ledger de todas as wallets). Resultados em test/load/results/.
 *
 * Uso: bun run test:load [cenário ...]   (padrão: todos)
 * Cenários: baseline, ramp, hot, duplicates, scale-1, scale-3, queue
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetQueueAttributesCommand, SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';

const ROOT = join(import.meta.dir, '../..');
const RESULTS = join(import.meta.dir, 'results');
const K6_IMAGE = 'grafana/k6:1.8.1';
const DATABASE_URL = 'postgres://wagering:wagering@localhost:5432/wagering';
const SQS_ENDPOINT = 'http://localhost:4566';
const ALL = ['baseline', 'ramp', 'hot', 'duplicates', 'scale-1', 'scale-3', 'queue'];

interface Sample {
  pending: number;
  lagSeconds: number;
}

interface ScenarioResult {
  scenario: string;
  replicas: number;
  durationSeconds: number;
  requests: number;
  throughput: number;
  latencyMs: Record<string, number>;
  statuses: Record<string, number>;
  errorRate: number;
  lock: { conflicts: number; timeouts: number; avgWaitMs: number };
  duplicates: Record<string, number>;
  outbox: {
    maxLagSeconds: number;
    avgLagSeconds: number;
    maxPending: number;
    drainSeconds: number;
  };
  correctness: { walletsChecked: number; inconsistent: number; chainBreaks: number };
  queue?: {
    messages: number;
    processed: number;
    dlq: number;
    drainSeconds: number;
    throughput: number;
  };
}

const sql = new SQL(DATABASE_URL);

async function sh(cmd: string[], options: { quiet?: boolean } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} falhou (${code}):\n${err || out}`);
  if (!options.quiet && out.trim()) console.log(out.trim());
  return out;
}

async function stack(replicas: number) {
  console.log(`\n▶ subindo o Compose com ${replicas} réplica(s)…`);
  await sh(['docker', 'compose', 'up', '-d', '--build', '--wait', '--scale', `app=${replicas}`], {
    quiet: true,
  });
}

async function appContainers(): Promise<string[]> {
  return (await sh(['docker', 'compose', 'ps', '-q', 'app'], { quiet: true }))
    .trim()
    .split('\n')
    .filter(Boolean);
}

/** Soma uma métrica Prometheus de todas as réplicas (contadores são por processo — ADR-28). */
async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const id of await appContainers()) {
    const text = await sh(
      [
        'docker',
        'exec',
        id,
        'bun',
        '-e',
        "console.log(await (await fetch('http://127.0.0.1:3000/metrics')).text())",
      ],
      { quiet: true },
    );
    for (const line of text.split('\n')) {
      const match = /^(wagering_[a-z_]+(?:\{[^}]*\})?) ([0-9.e+-]+)$/.exec(line);
      if (match?.[1] && match[2])
        totals.set(match[1], (totals.get(match[1]) ?? 0) + Number(match[2]));
    }
  }
  return totals;
}

const delta = (before: Map<string, number>, after: Map<string, number>, key: string) =>
  (after.get(key) ?? 0) - (before.get(key) ?? 0);

function startSampler(): { stop(): Promise<Sample[]> } {
  const samples: Sample[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const [row] = await sql`
        SELECT count(*)::int AS pending,
               COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float8 AS lag
          FROM outbox_messages WHERE published_at IS NULL`;
      samples.push({ pending: row.pending, lagSeconds: row.lag });
      await Bun.sleep(1_000);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return samples;
    },
  };
}

async function waitOutboxDrained(timeoutMs = 120_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [row] =
      await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
    if (row.n === 0) return (Date.now() - started) / 1000;
    await Bun.sleep(250);
  }
  throw new Error('outbox não drenou no tempo limite');
}

/** O critério de aprovação é correção: saldo == ledger e cadeia contínua em TODAS as wallets. */
async function correctness() {
  const [summary] = await sql`
    WITH rebuilt AS (
      SELECT w.id, w.balance,
             COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ledger
        FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       GROUP BY w.id, w.balance)
    SELECT count(*)::int AS wallets, count(*) FILTER (WHERE balance <> ledger)::int AS inconsistent
      FROM rebuilt`;
  const [chain] = await sql`
    SELECT count(*)::int AS breaks FROM (
      SELECT balance_before,
             lag(balance_after) OVER (PARTITION BY wallet_id ORDER BY wallet_version) AS previous_after
        FROM wallet_ledger_entries) c
     WHERE previous_after IS NOT NULL AND previous_after <> balance_before`;
  return {
    walletsChecked: summary.wallets,
    inconsistent: summary.inconsistent,
    chainBreaks: chain.breaks,
  };
}

async function runK6(scenario: string, replicas: number): Promise<ScenarioResult> {
  const k6Scenario = scenario.startsWith('scale') ? 'scale' : scenario;
  const network = `${await sh(['docker', 'compose', 'config', '--format', 'json'], { quiet: true }).then((j) => JSON.parse(j).name)}_default`;
  const before = await scrape();
  const sampler = startSampler();
  const started = Date.now();
  console.log(`▶ k6: ${scenario} (${replicas} réplica(s))…`);
  await sh(
    [
      'docker',
      'run',
      '--rm',
      // grava o resumo com o mesmo dono da pasta de resultados
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--network',
      network,
      '-v',
      `${join(import.meta.dir, 'k6')}:/scripts:ro`,
      '-v',
      `${RESULTS}:/results`,
      '-e',
      'TARGET=http://lb',
      '-e',
      `SCENARIO=${k6Scenario}`,
      K6_IMAGE,
      'run',
      '--quiet',
      '--summary-export',
      `/results/k6-${scenario}.json`,
      '/scripts/wagering.js',
    ],
    { quiet: true },
  );
  const durationSeconds = (Date.now() - started) / 1000;
  const drainSeconds = await waitOutboxDrained();
  const samples = await sampler.stop();
  const after = await scrape();
  const summary = JSON.parse(await Bun.file(join(RESULTS, `k6-${scenario}.json`)).text());

  const metric = (name: string) => summary.metrics[name] ?? {};
  const statuses: Record<string, number> = {};
  for (const [name, code] of [
    ['status_201_processed', '201'],
    ['status_200_replay', '200'],
    ['status_202_pending', '202'],
    ['status_409_conflict', '409'],
    ['status_422_rejected', '422'],
    ['status_503_unavailable', '503'],
    ['status_unexpected', 'outros'],
  ] as const)
    statuses[code] = metric(name).count ?? 0;

  const requests = metric('http_reqs').count ?? 0;
  const duration = metric('http_req_duration');
  const waitSum = delta(before, after, 'wagering_lock_wait_seconds_sum');
  const waitCount = delta(before, after, 'wagering_lock_wait_seconds_count');
  return {
    scenario,
    replicas,
    durationSeconds,
    requests,
    throughput: metric('http_reqs').rate ?? 0,
    latencyMs: {
      p50: duration.med,
      p90: duration['p(90)'],
      p95: duration['p(95)'],
      p99: duration['p(99)'],
      max: duration.max,
    },
    statuses,
    errorRate: requests ? ((statuses['503'] ?? 0) + (statuses.outros ?? 0)) / requests : 0,
    lock: {
      conflicts: delta(before, after, 'wagering_lock_conflicts_total'),
      timeouts: delta(before, after, 'wagering_lock_timeouts_total'),
      avgWaitMs: waitCount ? (waitSum / waitCount) * 1000 : 0,
    },
    duplicates: Object.fromEntries(
      ['idempotent_replay', 'payload_conflict'].map((type) => [
        type,
        delta(before, after, `wagering_duplicates_detected_total{source="HTTP",type="${type}"}`),
      ]),
    ),
    outbox: {
      maxLagSeconds: Math.max(0, ...samples.map((s) => s.lagSeconds)),
      avgLagSeconds: samples.length
        ? samples.reduce((a, s) => a + s.lagSeconds, 0) / samples.length
        : 0,
      maxPending: Math.max(0, ...samples.map((s) => s.pending)),
      drainSeconds,
    },
    correctness: await correctness(),
  };
}

/** ST-06: 5.000 mensagens na fila, consumidas pelas réplicas; mede a vazão de consumo. */
async function runQueue(replicas: number): Promise<ScenarioResult> {
  const sqs = new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const queueUrl = `${SQS_ENDPOINT}/000000000000/wager-transactions.fifo`;
  // o cenário roda sozinho: cria as próprias wallets (saldo de sobra para 5.000 apostas de 1.00)
  const wallets = await createWallets(100, '1000.00');
  const messages = 5_000;
  const run = crypto.randomUUID().slice(0, 8);
  const before = await scrape();
  const sampler = startSampler();
  console.log(`▶ fila: enviando ${messages} mensagens…`);
  for (let start = 0; start < messages; start += 10) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Array.from({ length: 10 }, (_, i) => {
          const n = start + i;
          const wallet = wallets[n % wallets.length];
          if (!wallet) throw new Error('sem wallets para o cenário de fila');
          const externalTransactionId = `q-${run}-${n}`;
          return {
            Id: String(i),
            MessageGroupId: wallet.id,
            MessageDeduplicationId: externalTransactionId,
            MessageBody: JSON.stringify({
              messageId: `msg-${externalTransactionId}`,
              type: 'WagerTransactionRequested',
              occurredAt: new Date().toISOString(),
              data: {
                providerId: 'load-queue',
                externalTransactionId,
                idempotencyKey: `load-queue:${externalTransactionId}`,
                playerId: wallet.player_id,
                walletId: wallet.id,
                roundId: 'r',
                gameId: 'g',
                kind: 'BET',
                money: { amount: '1.00', currency: 'BRL' },
              },
            }),
          };
        }),
      }),
    );
  }
  // terminou quando a fila esvaziou: processadas + DLQ = enviadas (sem esperar indefinidamente)
  const started = Date.now();
  for (;;) {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id LIKE ${`q-${run}-%`}`;
    if (row.n >= messages) break;
    if ((await queueDepth(sqs, queueUrl)) === 0 && Date.now() - started > 5_000) break;
    if (Date.now() - started > 600_000) throw new Error('fila não drenou em 10 min');
    await Bun.sleep(500);
  }
  const drainSeconds = (Date.now() - started) / 1000;
  const [final] = await sql`
    SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id LIKE ${`q-${run}-%`}`;
  const processed: number = final.n;
  await waitOutboxDrained();
  const samples = await sampler.stop();
  const after = await scrape();
  sqs.destroy();
  return {
    scenario: 'queue',
    replicas,
    durationSeconds: drainSeconds,
    requests: processed,
    throughput: processed / drainSeconds,
    latencyMs: {},
    statuses: {},
    errorRate: delta(before, after, 'wagering_dlq_messages_total') / messages,
    lock: {
      conflicts: delta(before, after, 'wagering_lock_conflicts_total'),
      timeouts: delta(before, after, 'wagering_lock_timeouts_total'),
      avgWaitMs: 0,
    },
    duplicates: {},
    outbox: {
      maxLagSeconds: Math.max(0, ...samples.map((s) => s.lagSeconds)),
      avgLagSeconds: samples.length
        ? samples.reduce((a, s) => a + s.lagSeconds, 0) / samples.length
        : 0,
      maxPending: Math.max(0, ...samples.map((s) => s.pending)),
      drainSeconds: 0,
    },
    correctness: await correctness(),
    queue: {
      messages,
      processed,
      dlq: messages - processed,
      drainSeconds,
      throughput: processed / drainSeconds,
    },
  };
}

async function createWallets(count: number, balance: string) {
  const wallets: { id: string; player_id: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const playerId = crypto.randomUUID();
    const res = await fetch('http://localhost:3000/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
    });
    if (res.status !== 201) throw new Error(`wallet: ${res.status} ${await res.text()}`);
    wallets.push({ id: ((await res.json()) as { id: string }).id, player_id: playerId });
  }
  return wallets;
}

async function queueDepth(sqs: SQSClient, url: string): Promise<number> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

async function environment() {
  const read = async (cmd: string[]) => (await sh(cmd, { quiet: true }).catch(() => '?')).trim();
  return {
    date: new Date().toISOString(),
    cpus: navigator.hardwareConcurrency,
    memory: await read(['bash', '-c', "free -h | awk '/Mem:/ {print $2}'"]),
    os: await read(['bash', '-c', '. /etc/os-release && echo $PRETTY_NAME']),
    kernel: await read(['uname', '-r']),
    docker: await read(['docker', 'version', '--format', '{{.Server.Version}}']),
    bun: Bun.version,
    postgres: (await sql`SHOW server_version`)[0].server_version,
    k6: K6_IMAGE,
    note: 'tudo na mesma VM: app, Postgres, LocalStack e o gerador de carga disputam os mesmos recursos',
  };
}

async function main() {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
  mkdirSync(RESULTS, { recursive: true });
  console.log('▶ ambiente limpo (docker compose down -v)…');
  await sh(['docker', 'compose', 'down', '-v'], { quiet: true });

  const results: ScenarioResult[] = [];
  let current = 0;
  for (const scenario of wanted) {
    const replicas = scenario === 'scale-1' ? 1 : 3;
    if (replicas !== current) {
      await stack(replicas);
      current = replicas;
    }
    const result =
      scenario === 'queue' ? await runQueue(replicas) : await runK6(scenario, replicas);
    results.push(result);
    console.log(
      JSON.stringify({
        scenario,
        throughput: result.throughput.toFixed(1),
        latencyMs: result.latencyMs,
        correctness: result.correctness,
      }),
    );
  }

  const report = { environment: await environment(), results };
  const file = join(RESULTS, `load-${report.environment.date.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  writeFileSync(join(RESULTS, 'latest.json'), JSON.stringify(report, null, 2));
  await sql.close();

  const broken = results.filter(
    (r) => r.correctness.inconsistent > 0 || r.correctness.chainBreaks > 0,
  );
  console.log(`\n✔ resultados em ${file}`);
  if (broken.length) {
    console.error(`✘ CORREÇÃO VIOLADA em: ${broken.map((r) => r.scenario).join(', ')}`);
    process.exit(1);
  }
}

await main();
