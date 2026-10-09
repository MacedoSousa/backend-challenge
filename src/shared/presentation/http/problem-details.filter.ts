import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';
import { DomainError, type ErrorCategory } from '../../domain/domain-error';
import { FailureCode } from '../../domain/failure-code';
import { LOGGER } from '../../infrastructure/logging/logging.module';
import { currentContext } from '../../infrastructure/logging/request-context';

/** Status por código específico; o restante segue a categoria (docs/01 §8). */
const STATUS_BY_CODE: Partial<Record<FailureCode, number>> = {
  [FailureCode.WalletNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.TransactionNotFound]: HttpStatus.NOT_FOUND,
};

const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: HttpStatus.BAD_REQUEST,
  conflict: HttpStatus.CONFLICT,
  business: HttpStatus.UNPROCESSABLE_ENTITY,
  transient: HttpStatus.SERVICE_UNAVAILABLE,
  permanent: HttpStatus.INTERNAL_SERVER_ERROR,
};

const RETRY_AFTER_SECONDS = '1';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  failureCode?: string;
  detail?: string;
  correlationId?: string;
  errors?: unknown;
}

/**
 * Erros no formato RFC 9457 (application/problem+json), com mapeamento único e
 * consistente para todos os endpoints. Erros inesperados nunca vazam detalhes internos.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const problem = this.toProblem(exception);
    if (problem.status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ProblemDetails {
    const correlationId = currentContext()?.correlationId;
    const base = correlationId ? { correlationId } : {};

    if (exception instanceof DomainError) {
      const status = STATUS_BY_CODE[exception.code] ?? STATUS_BY_CATEGORY[exception.category];
      if (exception.category === 'transient') {
        this.logger.warn(
          { failureCode: exception.code, details: exception.details },
          exception.message,
        );
      }
      const { errors, ...details } = exception.details as { errors?: unknown };
      return {
        type: `urn:wagering:problem:${exception.code.toLowerCase()}`,
        title: exception.code,
        status,
        failureCode: exception.code,
        detail: exception.message,
        ...base,
        ...(errors !== undefined
          ? { errors }
          : Object.keys(details).length
            ? { errors: details }
            : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // ex.: JSON malformado no corpo — mesma classificação de payload inválido
      const failureCode =
        status === HttpStatus.BAD_REQUEST ? FailureCode.ValidationError : undefined;
      return {
        type: 'about:blank',
        title: exception.message,
        status,
        ...(failureCode ? { failureCode } : {}),
        ...base,
      };
    }

    this.logger.error({ err: exception }, 'unhandled error');
    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      ...base,
    };
  }
}
