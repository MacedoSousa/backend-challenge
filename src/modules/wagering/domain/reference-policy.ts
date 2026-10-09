import { FailureCode } from '../../../shared/domain/failure-code';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from './wager-transaction';

/**
 * Tipos que cada operação pode referenciar. REFUND e ROLLBACK passam pelo mesmo fluxo:
 * a única diferença entre eles é esta tabela (ADR-08).
 */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, readonly Kind[]>>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
};

export type ReferenceDecision =
  | { type: 'APPLY'; reference?: WagerTransaction }
  | { type: 'WAIT' }
  | { type: 'REJECT'; code: FailureCode; relatedTransactionId?: string };

export interface ReferenceEvaluation {
  transaction: WagerTransaction;
  /** Resolvida por (providerId, referenceExternalTransactionId); ausente = ainda não chegou. */
  reference?: WagerTransaction | undefined;
  /** Reversão PROCESSED já existente sobre a mesma referência (qualquer tipo). */
  existingReversal?: WagerTransaction | undefined;
}

/**
 * Política única de referência (docs/05 §12). Pura e determinística: o use case resolve
 * as transações sob lock e esta classe só decide.
 */
export class ReferencePolicy {
  evaluate({ transaction, reference, existingReversal }: ReferenceEvaluation): ReferenceDecision {
    if (!transaction.referenceExternalTransactionId) return { type: 'APPLY' };
    if (!reference) return { type: 'WAIT' };

    const allowed = ALLOWED_REFERENCE_KINDS[transaction.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return reject(FailureCode.ReferenceInvalidKind);
    }
    if (!sameContext(transaction, reference)) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (transaction.isReversal() && !transaction.money.equals(reference.money)) {
      return reject(FailureCode.AmountMismatch);
    }
    if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
      return { type: 'WAIT' };
    }
    if (reference.status !== Status.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (transaction.isReversal() && existingReversal) {
      return {
        type: 'REJECT',
        code: FailureCode.ReferenceAlreadyReversed,
        relatedTransactionId: existingReversal.id,
      };
    }
    return { type: 'APPLY', reference };
  }
}

function reject(code: FailureCode): ReferenceDecision {
  return { type: 'REJECT', code };
}

/** Mesmo provider, player, wallet, moeda e rodada (§7 regra 2). */
function sameContext(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    transaction.providerId === reference.providerId &&
    transaction.playerId === reference.playerId &&
    transaction.walletId === reference.walletId &&
    transaction.money.currency === reference.money.currency &&
    transaction.roundId === reference.roundId
  );
}
