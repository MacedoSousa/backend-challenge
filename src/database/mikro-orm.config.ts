import { join } from 'node:path';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import type { Env } from '../config/env';

const MIGRATIONS_PATH = join(import.meta.dir, 'migrations');

export function createOrmConfig(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'NODE_ENV'>) {
  return defineConfig({
    clientUrl: env.DATABASE_URL,
    // entidades ORM são registradas por cada módulo a partir da Iteração 2
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: env.DB_POOL_MAX },
    // Bun executa TypeScript diretamente: migrations são lidas como .ts
    preferTs: true,
    extensions: [Migrator],
    migrations: {
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      glob: '!(*.d).ts',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
    },
    debug: false,
    allowGlobalContext: env.NODE_ENV === 'test',
  });
}
