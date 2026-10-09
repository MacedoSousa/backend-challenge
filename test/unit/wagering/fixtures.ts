import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { Money } from '../../../src/shared/domain/money';

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const T0 = new Date('2026-10-09T12:00:00.000Z');
export const T1 = new Date('2026-10-09T12:00:05.000Z');

let sequence = 0;

/** Transação válida com defaults; sobrescreva só o que importa para o teste. */
export function makeTransaction(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${sequence}`;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: T0,
    ...overrides,
  });
}

/** Transação já PROCESSED (ex.: a BET que será referenciada). */
export function processed(overrides: Partial<CreateWagerTransactionProps> = {}) {
  const transaction = makeTransaction(overrides);
  transaction.markProcessed({ at: T0, balanceAfter: brl('75.00') });
  return transaction;
}
