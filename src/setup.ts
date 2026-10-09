import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from './config/env';
import { createOrmConfig } from './database/mikro-orm.config';
import { ensureQueues } from './shared/infrastructure/sqs/queues';
import { createSqsClient } from './shared/infrastructure/sqs/sqs.module';

/**
 * Preparação idempotente do ambiente (usada pelo serviço `setup` do Compose):
 * aplica migrations pendentes e garante a topologia de filas.
 */
const env = loadEnv();

const orm = await MikroORM.init(createOrmConfig(env));
try {
  const applied = await orm.getMigrator().up();
  console.log(`migrations aplicadas: ${applied.map((m) => m.name).join(', ') || 'nenhuma'}`);
} finally {
  await orm.close(true);
}

const sqs = createSqsClient(env);
try {
  await ensureQueues(sqs, env);
  console.log(
    `filas prontas: ${env.SQS_WAGER_QUEUE}, ${env.SQS_WAGER_DLQ}, ${env.SQS_EVENTS_QUEUE}`,
  );
} finally {
  sqs.destroy();
}
