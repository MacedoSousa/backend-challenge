import { http, type JsonResponse } from './app';
import { uuid } from './database';

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export async function createWallet(url: string, initial = '1000.00'): Promise<TestWallet> {
  const res = await http(`${url}/wallets`, {
    method: 'POST',
    body: { playerId: uuid(), initialBalance: brl(initial) },
  });
  if (res.status !== 201) throw new Error(`falha ao criar wallet: ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId: res.body.playerId as string };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Payload válido de BET; sobrescreva o que importa no teste. */
export function wager(wallet: TestWallet, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${uuid()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

export type WagerResult = {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
  failureCode?: string;
  relatedTransactionId?: string;
};

/** POST /wagering/transactions com a Idempotency-Key padrão `{providerId}:{externalTransactionId}`. */
export function submit(
  url: string,
  body: WagerBody | Record<string, unknown>,
  options: { key?: string | null; headers?: Record<string, string> } = {},
): Promise<JsonResponse<WagerResult & Record<string, unknown>>> {
  const b = body as WagerBody;
  const key =
    options.key === undefined ? `${b.providerId}:${b.externalTransactionId}` : options.key;
  return http(`${url}/wagering/transactions`, {
    method: 'POST',
    body,
    headers: { ...(key === null ? {} : { 'idempotency-key': key }), ...options.headers },
  });
}
