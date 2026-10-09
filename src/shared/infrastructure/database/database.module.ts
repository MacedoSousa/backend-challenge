import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { createOrmConfig } from '../../../database/mikro-orm.config';
import { UNIT_OF_WORK } from '../../application/ports';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Global()
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => createOrmConfig(env),
      driver: PostgreSqlDriver,
    }),
  ],
  providers: [{ provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork }],
  exports: [UNIT_OF_WORK],
})
export class DatabaseModule {}
