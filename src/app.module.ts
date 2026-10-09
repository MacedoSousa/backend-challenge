import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import {
  LoggingModule,
  RequestContextMiddleware,
} from './shared/infrastructure/logging/logging.module';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module';

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env) {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggingModule,
        DatabaseModule,
        SqsModule,
        AuthModule,
        HealthModule,
        // módulos de domínio entram a partir da Iteração 2, condicionados a env.APP_ROLE
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
