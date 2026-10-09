import { createParamDecorator } from '@nestjs/common';
import type { RequestMeta } from '../../application/ports';
import { currentContext } from '../../infrastructure/logging/request-context';

/** Injeta o correlationId da requisição para que os eventos gerados o carreguem. */
export const Meta = createParamDecorator((): RequestMeta => {
  const correlationId = currentContext()?.correlationId;
  if (!correlationId) throw new Error('contexto de requisição ausente');
  return { correlationId };
});
