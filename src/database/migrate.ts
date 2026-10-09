import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../config/env';
import { createOrmConfig } from './mikro-orm.config';

/**
 * CLI de migrations: `bun src/database/migrate.ts <up|down|create|pending>`.
 * Mantido em código (e não no CLI do MikroORM) para rodar com o mesmo runtime e config da app.
 */
const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(createOrmConfig(loadEnv()));
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(`migrations aplicadas: ${applied.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(`migration revertida: ${reverted.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'pending': {
      const pending = await migrator.getPendingMigrations();
      console.log(`pendentes: ${pending.map((m) => m.name).join(', ') || 'nenhuma'}`);
      break;
    }
    case 'create': {
      const result = await migrator.createMigration(undefined, true);
      console.log(`criada: ${result.fileName}`);
      break;
    }
    default:
      throw new Error(`comando desconhecido: ${command} (use up | down | pending | create)`);
  }
} finally {
  await orm.close(true);
}
