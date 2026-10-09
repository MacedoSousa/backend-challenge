import { join } from 'node:path';
import type { Subprocess } from 'bun';
import type { Env } from '../../../src/config/env';

const ROOT = join(import.meta.dir, '../../..');

export interface Instance {
  name: string;
  url: string;
  proc: Subprocess;
  logs: string[];
  /** Envia o sinal e espera o processo terminar; devolve código e sinal de saída. */
  stop(
    signal?: 'SIGTERM' | 'SIGKILL',
  ): Promise<{ exitCode: number | null; signalCode: string | null }>;
  exited(): Promise<{ exitCode: number | null; signalCode: string | null }>;
}

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

/** Variáveis de ambiente do processo filho a partir do Env dos testes (tudo como string). */
function toProcessEnv(env: Env, overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    base[key] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return { ...(process.env as Record<string, string>), ...base, ...overrides };
}

/**
 * Sobe uma instância real da aplicação (`bun src/main.ts`) — processo separado, com seu
 * próprio pool, workers e métricas — e espera o `/health/live` responder.
 */
export async function spawnInstance(
  env: Env,
  name: string,
  overrides: Record<string, string> = {},
  /** `false` para vítimas de falha injetada: podem morrer antes mesmo de abrir a porta. */
  waitReady = true,
): Promise<Instance> {
  const port = freePort();
  const logs: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: toProcessEnv(env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      PORT: String(port),
      INSTANCE_ID: name,
      ...overrides,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  collect(proc.stdout, logs);
  collect(proc.stderr, logs);

  const url = `http://127.0.0.1:${port}`;
  const exited = async () => {
    await proc.exited;
    return { exitCode: proc.exitCode, signalCode: proc.signalCode };
  };
  const deadline = Date.now() + 30_000;
  while (waitReady) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`instância ${name} morreu no boot:\n${logs.join('')}`);
    }
    try {
      if ((await fetch(`${url}/health/live`)).ok) break;
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline)
      throw new Error(`instância ${name} não ficou pronta:\n${logs.join('')}`);
    await Bun.sleep(100);
  }

  return {
    name,
    url,
    proc,
    logs,
    exited,
    async stop(signal = 'SIGTERM') {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return exited();
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array> | undefined, into: string[]) {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.push(decoder.decode(chunk));
}

export const ALL_ROLES = { APP_ROLE: 'api,consumer,outbox,scheduler' };

/** Workers rápidos para os testes. */
export const FAST_WORKERS = {
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '3',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_WORKER_INTERVAL_MS: '100',
  OUTBOX_LEASE_MS: '2000',
};
