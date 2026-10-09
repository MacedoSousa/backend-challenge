import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import type { Env } from './config/env';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import {
  LoggingModule,
  RequestContextMiddleware,
} from './shared/infrastructure/logging/logging.module';
import { PlatformModule } from './shared/infrastructure/platform.module';
import { SqsModule } from './shared/infrastructure/sqs/sqs.module';
import { ProblemDetailsFilter } from './shared/presentation/http/problem-details.filter';

@Module({})
export class AppModule implements NestModule {
  static forRoot(env: Env) {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggingModule,
        PlatformModule,
        DatabaseModule,
        SqsModule,
        AuthModule,
        HealthModule,
        WalletModule,
        WageringModule,
        MessagingModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
