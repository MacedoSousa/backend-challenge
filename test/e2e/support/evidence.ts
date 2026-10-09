/**
 * Gravador de evidências: cada cenário roda num contexto do Playwright com vídeo.
 * - aba "console": painel que mostra, ao vivo, cada requisição (método, rota, corpo,
 *   status, resposta), consulta ao banco e verificação ✅/❌ — o vídeo é a evidência
 *   dos fluxos de API, que não têm tela própria;
 * - aba "web": Grafana, Prometheus, Mailpit, quando o cenário envolve uma tela.
 * Ao final: index.html + summary.json com vídeos e capturas de todos os cenários.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SQL } from 'bun';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const VIEWPORT = { width: 1280, height: 800 };
const PAUSE_MS = 350; // deixa cada passo legível no vídeo

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

interface ScenarioRecord {
  id: string;
  title: string;
  category: string;
  status: 'passed' | 'failed';
  error?: string;
  durationSeconds: number;
  steps: number;
  videos: string[];
  screenshots: string[];
}

const CONSOLE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Evidência</title>
<style>
  body{margin:0;background:#0f1217;color:#d7dce4;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}
  header{position:sticky;top:0;background:#161b22;border-bottom:1px solid #2b3240;padding:14px 20px;z-index:2}
  header h1{margin:0;font:600 18px system-ui,sans-serif;color:#fff}
  header p{margin:4px 0 0;color:#8b949e;font:13px system-ui,sans-serif}
  #steps{padding:12px 20px 80px}
  .step{border:1px solid #2b3240;border-radius:8px;margin:10px 0;padding:10px 12px;background:#131820}
  .head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .kind{font:600 11px system-ui;padding:2px 7px;border-radius:4px;background:#30363d;color:#c9d1d9}
  .http .kind{background:#1f6feb33;color:#79c0ff}.sql .kind{background:#8957e533;color:#d2a8ff}
  .note .kind{background:#30363d}.ok{border-color:#2ea04366}.fail{border-color:#f8514999}
  .ok .kind{background:#2ea04333;color:#7ee787}.fail .kind{background:#f8514933;color:#ffa198}
  .status{margin-left:auto;font-weight:700}.s2{color:#7ee787}.s4{color:#e3b341}.s5{color:#ffa198}
  pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-all;color:#c9d1d9;max-height:220px;overflow:hidden}
  .label{color:#8b949e;font:12px system-ui;margin-top:6px}
</style></head><body>
<header><h1 id="title"></h1><p id="subtitle"></p></header><div id="steps"></div>
<script>
  window.setTitle=(t,s)=>{document.getElementById('title').textContent=t;document.getElementById('subtitle').textContent=s};
  window.addStep=(s)=>{const el=document.createElement('div');el.className='step '+s.cls;
    const head=document.createElement('div');head.className='head';
    const k=document.createElement('span');k.className='kind';k.textContent=s.kind;head.appendChild(k);
    const t=document.createElement('span');t.textContent=s.title;head.appendChild(t);
    if(s.status){const st=document.createElement('span');st.className='status s'+String(s.status)[0];st.textContent=s.status;head.appendChild(st)}
    el.appendChild(head);
    for(const [label,body] of s.blocks||[]){const l=document.createElement('div');l.className='label';l.textContent=label;el.appendChild(l);
      const p=document.createElement('pre');p.textContent=body;el.appendChild(p)}
    document.getElementById('steps').appendChild(el);window.scrollTo(0,document.body.scrollHeight)};
</script></body></html>`;

const pretty = (value: unknown, max = 1_200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} caracteres omitidos)`
    : text;
};

export class Scenario {
  private webPage: Page | undefined;
  steps = 0;
  readonly screenshots: string[] = [];

  constructor(
    private readonly context: BrowserContext,
    readonly consolePage: Page,
    private readonly dir: string,
    private readonly sql: SQL,
  ) {}

  private async step(step: {
    cls: string;
    kind: string;
    title: string;
    status?: string | number;
    blocks?: [string, string][];
  }) {
    this.steps += 1;
    await this.consolePage.evaluate(
      (s) => (globalThis as unknown as { addStep: (x: unknown) => void }).addStep(s),
      {
        ...step,
        status: step.status === undefined ? undefined : String(step.status),
      },
    );
    await this.consolePage.waitForTimeout(PAUSE_MS);
  }

  note(text: string) {
    return this.step({ cls: 'note', kind: 'PASSO', title: text });
  }

  async http<T = Record<string, unknown>>(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string>; label?: string } = {},
  ): Promise<HttpResult<T>> {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // resposta não-JSON (ex.: /metrics)
    }
    const blocks: [string, string][] = [];
    if (options.headers && Object.keys(options.headers).length) {
      blocks.push(['headers enviados', pretty(options.headers)]);
    }
    if (options.body !== undefined) blocks.push(['corpo enviado', pretty(options.body)]);
    blocks.push(['resposta', pretty(body, 900)]);
    await this.step({
      cls: 'http',
      kind: method,
      title: `${options.label ? `${options.label} — ` : ''}${url.replace(/^https?:\/\/[^/]+/, '')}`,
      status: res.status,
      blocks,
    });
    return { status: res.status, headers: res.headers, body: body as T };
  }

  async query<T = Record<string, unknown>>(label: string, query: Promise<T[]>): Promise<T[]> {
    const rows = await query;
    await this.step({
      cls: 'sql',
      kind: 'BANCO',
      title: label,
      blocks: [['linhas', pretty(rows, 900)]],
    });
    return rows;
  }

  async check(label: string, condition: boolean, detail?: unknown) {
    await this.step({
      cls: condition ? 'ok' : 'fail',
      kind: condition ? '✅ OK' : '❌ FALHOU',
      title: label,
      ...(detail === undefined
        ? {}
        : { blocks: [['detalhe', pretty(detail)]] as [string, string][] }),
    });
    if (!condition)
      throw new Error(`verificação falhou: ${label} ${detail ? pretty(detail, 300) : ''}`);
  }

  /** Abre (ou reutiliza) a aba web, navega e salva uma captura. */
  async show(name: string, url: string, waitFor?: (page: Page) => Promise<void>) {
    this.webPage ??= await this.context.newPage();
    await this.webPage.goto(url);
    if (waitFor) await waitFor(this.webPage);
    await this.webPage.waitForTimeout(1_200);
    const file = join(this.dir, `${name}.png`);
    await this.webPage.screenshot({ path: file });
    this.screenshots.push(file);
    await this.note(`tela capturada: ${name}.png (${url.replace(/\?.*$/, '')})`);
    return this.webPage;
  }

  get sqlClient() {
    return this.sql;
  }
}

export class EvidenceRun {
  readonly dir: string;
  private readonly records: ScenarioRecord[] = [];
  private readonly startedAt = new Date();

  constructor(
    private readonly browser: Browser,
    root: string,
    private readonly sql: SQL,
    private readonly meta: Record<string, string>,
  ) {
    this.dir = join(root, this.startedAt.toISOString().replace(/[:.]/g, '-'));
    mkdirSync(this.dir, { recursive: true });
  }

  async scenario(
    id: string,
    category: string,
    title: string,
    run: (scenario: Scenario) => Promise<void>,
  ): Promise<void> {
    const dir = join(this.dir, id);
    mkdirSync(dir, { recursive: true });
    const context = await this.browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir, size: VIEWPORT },
    });
    // sessão do Grafana para as telas (sem acesso anônimo); cookie compartilhado pelo contexto
    await context.request.post('http://localhost:3001/login', {
      data: { user: 'admin', password: 'admin' },
    });
    const consolePage = await context.newPage();
    await consolePage.setContent(CONSOLE_HTML);
    await consolePage.evaluate(
      ([t, s]) =>
        (globalThis as unknown as { setTitle: (a: string, b: string) => void }).setTitle(t, s),
      [`${id} · ${title}`, `${category} — ${new Date().toLocaleString('pt-BR')}`] as const,
    );
    const scenario = new Scenario(context, consolePage, dir, this.sql);

    const started = Date.now();
    let error: unknown;
    try {
      await run(scenario);
      await scenario.note('cenário concluído ✅');
    } catch (failure) {
      error = failure;
      await scenario
        .note(`cenário FALHOU: ${failure instanceof Error ? failure.message : String(failure)}`)
        .catch(() => {});
    }

    const pages = context.pages();
    await consolePage.waitForTimeout(800);
    await context.close(); // finaliza os vídeos
    const videos: string[] = [];
    for (const [index, page] of pages.entries()) {
      const source = await page.video()?.path();
      if (!source) continue;
      const target = join(dir, `${id}-${index === 0 ? 'console' : 'tela'}.webm`);
      renameSync(source, target);
      videos.push(target);
    }

    this.records.push({
      id,
      title,
      category,
      status: error ? 'failed' : 'passed',
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      durationSeconds: (Date.now() - started) / 1000,
      steps: scenario.steps,
      videos,
      screenshots: scenario.screenshots,
    });
    this.writeIndex();
    if (error) throw error;
  }

  writeIndex() {
    const rel = (file: string) => relative(this.dir, file);
    const summary = {
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...this.meta,
      passed: this.records.filter((r) => r.status === 'passed').length,
      failed: this.records.filter((r) => r.status === 'failed').length,
      scenarios: this.records.map((r) => ({
        ...r,
        videos: r.videos.map(rel),
        screenshots: r.screenshots.map(rel),
      })),
    };
    writeFileSync(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const rows = this.records
      .map(
        (r) =>
          `<tr class="${r.status}"><td>${r.id}</td><td>${r.category}</td><td>${r.title}${
            r.error ? `<div class="err">${escapeHtml(r.error)}</div>` : ''
          }</td><td>${r.status === 'passed' ? '✅' : '❌'}</td><td>${r.durationSeconds.toFixed(1)} s</td><td>${r.steps}</td><td>${r.videos
            .map((v) => `<a href="${rel(v)}">${rel(v).split('/').pop()}</a>`)
            .join('<br>')}</td><td>${r.screenshots
            .map((s) => `<a href="${rel(s)}"><img src="${rel(s)}" alt=""></a>`)
            .join('')}</td></tr>`,
      )
      .join('\n');
    writeFileSync(
      join(this.dir, 'index.html'),
      `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Evidências — Wagering Processor</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1f2328}h1{margin:0 0 4px}p{color:#57606a}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f6f8fa}tr.failed{background:#fff1f0}.err{color:#cf222e;font-size:12px;margin-top:4px}
img{height:60px;margin:2px;border:1px solid #d0d7de}</style></head><body>
<h1>Evidências de execução — Distributed Wagering Processor</h1>
<p>Início ${summary.startedAt} · fim ${summary.finishedAt} · ${summary.passed} cenários ok, ${summary.failed} com falha · ${Object.entries(
        this.meta,
      )
        .map(([k, v]) => `${k}: ${escapeHtml(v)}`)
        .join(' · ')}</p>
<table><tr><th>ID</th><th>Categoria</th><th>Cenário</th><th>Resultado</th><th>Duração</th><th>Passos</th><th>Vídeos</th><th>Capturas</th></tr>
${rows}</table></body></html>`,
    );
  }
}

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}
