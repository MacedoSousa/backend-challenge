import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { type Env, loadEnv } from './config/env';
import { createLogger, PinoNestLogger } from './shared/infrastructure/logging/logger';

export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(env), {
    logger: new PinoNestLogger(createLogger(env)),
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  return app;
}

if (import.meta.main) {
  const env = loadEnv();
  const logger = createLogger(env);
  const app = await createApp(env);
  await app.listen(env.PORT);
  logger.info({ port: env.PORT, roles: env.APP_ROLE }, 'wagering-processor started');
}
