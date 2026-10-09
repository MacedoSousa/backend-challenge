import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import type { Env } from '../../../config/env';
import { currentContext } from './request-context';

/**
 * Caminhos removidos dos logs: payloads financeiros e credenciais nunca são registrados.
 * Valores monetários devem ser logados, quando necessário, apenas via métricas/auditoria.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.money',
  '*.amount',
  '*.balance',
  '*.payload',
  'body',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'INSTANCE_ID' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'wagering-processor', env: env.NODE_ENV, instance_id: env.INSTANCE_ID },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin: () => ({ ...currentContext() }),
  });
}

/** Adaptador para que o NestJS escreva pelo mesmo logger JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
