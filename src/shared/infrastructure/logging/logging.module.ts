import { Global, Inject, Injectable, Module, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { createLogger } from './logger';
import { runWithContext } from './request-context';

export const LOGGER = Symbol('LOGGER');

export const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Lê ou gera o correlationId, abre o contexto assíncrono da requisição
 * e registra um log por requisição concluída.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const received = req.header(CORRELATION_HEADER);
    const correlationId =
      received && CORRELATION_ID_PATTERN.test(received) ? received : Bun.randomUUIDv7();
    res.setHeader(CORRELATION_HEADER, correlationId);

    const startedAt = performance.now();
    runWithContext({ correlationId }, () => {
      res.on('finish', () => {
        this.logger.info(
          {
            http: {
              method: req.method,
              path: req.route?.path ?? req.path,
              status: res.statusCode,
              duration_ms: Math.round(performance.now() - startedAt),
            },
          },
          'request completed',
        );
      });
      next();
    });
  }
}

@Global()
@Module({
  providers: [
    { provide: LOGGER, inject: [APP_CONFIG], useFactory: (env: Env) => createLogger(env) },
    RequestContextMiddleware,
  ],
  exports: [LOGGER, RequestContextMiddleware],
})
export class LoggingModule {}
