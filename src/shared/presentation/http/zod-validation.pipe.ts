import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { RequestValidationError } from '../../application/errors';

/** Valida e converte a entrada com o schema zod; falhas viram 400 VALIDATION_ERROR. */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new RequestValidationError('payload inválido', {
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(raiz)',
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
