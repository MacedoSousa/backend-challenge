import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos propagados automaticamente para todos os logs de uma requisição/mensagem. */
export interface RequestContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Enriquece o contexto atual (ex.: quando o use case descobre o walletId). */
export function enrichContext(fields: Partial<Omit<RequestContext, 'correlationId'>>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}
