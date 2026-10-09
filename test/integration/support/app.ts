import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import type { Env } from '../../../src/config/env';
import { configureApp, createApp } from '../../../src/main';
import { ensureQueues } from '../../../src/shared/infrastructure/sqs/queues';
import { createSqsClient } from '../../../src/shared/infrastructure/sqs/sqs.module';
import { migrate } from './database';

export interface RunningApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

/** Prepara banco e filas e sobe a aplicação real numa porta efêmera. */
export interface StartAppOptions {
  /** Substitui provedores (ex.: uma PlayerSessionPolicy restritiva) via @nestjs/testing. */
  overrides?: { provide: unknown; useValue: unknown }[];
  /** Pula migrations/filas quando outra instância do mesmo teste já preparou o ambiente. */
  skipSetup?: boolean;
}

export async function startApp(env: Env, options: StartAppOptions = {}): Promise<RunningApp> {
  if (!options.skipSetup) {
    await migrate(env);
    const sqs = createSqsClient(env);
    await ensureQueues(sqs, env);
    sqs.destroy();
  }

  const app = options.overrides?.length
    ? await createOverriddenApp(env, options.overrides)
    : await createApp(env);
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

export interface JsonResponse<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

export async function http<T = Record<string, unknown>>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...init.headers },
    ...(init.body !== undefined
      ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }
      : {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : ({} as T) };
}

async function createOverriddenApp(env: Env, overrides: { provide: unknown; useValue: unknown }[]) {
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  for (const override of overrides) {
    builder = builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  return configureApp(moduleRef.createNestApplication(), env);
}
