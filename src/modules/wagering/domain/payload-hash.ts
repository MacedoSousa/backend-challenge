import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../../shared/domain/money';

/** Subconjunto de negócio que identifica uma operação (header e transporte não entram). */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

const HASHED_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const satisfies readonly (keyof WagerPayload)[];

/**
 * JSON canônico: só os campos de negócio, chaves ordenadas em todos os níveis e campos
 * ausentes/undefined omitidos. O valor monetário é validado pelo Money (forma canônica
 * obrigatória), então "25.00" e "25" nunca coexistem: o segundo é recusado na entrada.
 */
export function canonicalJson(payload: WagerPayload): string {
  const subset: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) {
    const value = payload[field];
    if (value === undefined) continue;
    subset[field] = field === 'money' ? Money.from(value as MoneyProps).toJSON() : value;
  }
  return JSON.stringify(sortKeys(subset));
}

/** payloadHash = SHA-256 (hex) do JSON canônico. Documentado em docs/01 §6 e ADR-05. */
export function payloadHash(payload: WagerPayload): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Hash da transação interna OPENING: identifica a abertura de forma determinística. */
export function openingPayloadHash(walletId: string, playerId: string, money: MoneyProps): string {
  const canonical = JSON.stringify(
    sortKeys({ kind: 'OPENING', walletId, playerId, money: Money.from(money).toJSON() }),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
