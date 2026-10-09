import { z } from 'zod';
import { WagerTransactionKind } from '../domain/wager-transaction';

/** Contrato de uma transação de aposta — o mesmo na API HTTP e na fila SQS (§10). */
export const WagerTransactionBody = z
  .object({
    providerId: z.string().min(1).max(100),
    externalTransactionId: z.string().min(1).max(200),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().min(1).max(200),
    gameId: z.string().min(1).max(200),
    // OPENING é interno: não faz parte do contrato externo
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z.object({ amount: z.string(), currency: z.string() }).strict(),
    referenceExternalTransactionId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const IdempotencyKey = z
  .string({ error: 'header Idempotency-Key é obrigatório' })
  .min(1)
  .max(300)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key deve conter apenas ASCII visível');

/** Mensagem da fila `wager-transactions.fifo` (formato do §10). */
export const WagerTransactionRequestedMessage = z
  .object({
    messageId: z.string().min(1).max(200),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: WagerTransactionBody.extend({ idempotencyKey: IdempotencyKey }).strict(),
  })
  .strict();

export type WagerTransactionRequested = z.output<typeof WagerTransactionRequestedMessage>;
