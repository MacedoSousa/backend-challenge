import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Env, loadEnv } from '../../../src/config/env';

export const POSTGRES_IMAGE = 'postgres:17-alpine';
export const LOCALSTACK_IMAGE = 'localstack/localstack:4';

export interface TestEnvironment {
  env: Env;
  postgres: StartedPostgreSqlContainer;
  localstack: StartedLocalStackContainer;
  stop(): Promise<void>;
}

/**
 * Sobe PostgreSQL e LocalStack reais (Testcontainers) e devolve um Env apontando para eles.
 * Nada de mocks de infraestrutura: é o que o desafio exige dos testes de integração.
 */
export async function startTestEnvironment(overrides: Record<string, string> = {}) {
  const [postgres, localstack] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('wagering')
      .withUsername('wagering')
      .withPassword('wagering')
      .start(),
    new LocalstackContainer(LOCALSTACK_IMAGE).withEnvironment({ SERVICES: 'sqs' }).start(),
  ]);

  const env = loadEnv({
    NODE_ENV: 'test',
    // workers (outbox, consumidor, scheduler) só sobem nos testes que os pedem explicitamente
    APP_ROLE: 'api',
    LOG_LEVEL: 'warn',
    PORT: '0',
    DATABASE_URL: postgres.getConnectionUri(),
    AWS_ENDPOINT_URL: localstack.getConnectionUri(),
    ...overrides,
  });

  return {
    env,
    postgres,
    localstack,
    async stop() {
      await Promise.allSettled([postgres.stop(), localstack.stop()]);
    },
  } satisfies TestEnvironment;
}
