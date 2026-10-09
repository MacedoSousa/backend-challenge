import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { createOrmConfig } from '../../../database/mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (env: Env) => createOrmConfig(env),
      driver: PostgreSqlDriver,
    }),
  ],
})
export class DatabaseModule {}
