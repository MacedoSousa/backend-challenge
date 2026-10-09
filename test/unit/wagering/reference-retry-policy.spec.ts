import { describe, expect, it } from 'bun:test';
import { WagerTransactionRejected } from '../../../src/modules/messaging/domain/events/wager-transaction-rejected';
import { ReferenceRetryPolicy } from '../../../src/modules/wagering/domain/reference-retry-policy';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/modules/wagering/domain/wager-transaction';
import { FailureCode } from '../../../src/shared/domain/failure-code';
import { brl, makeTransaction, T0 } from './fixtures';

const SECOND = 1_000;
const noJitter = new ReferenceRetryPolicy({ random: () => 0 });
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);
const pending = () => {
  const tx = makeTransaction({
    kind: Kind.Refund,
    referenceExternalTransactionId: 'bet-1',
    createdAt: T0,
  });
  tx.markPendingReference(noJitter.firstAttemptAt(T0));
  return tx;
};

describe('ReferenceRetryPolicy (§7.1)', () => {
  it('UT-R01 primeira tentativa 1 s após virar PENDING_REFERENCE', () => {
    expect(noJitter.firstAttemptAt(T0)).toEqual(plus(T0, SECOND));
  });

  it('UT-R02 backoff exponencial 2s, 4s, … com teto de 60 s; expira na 10ª tentativa', () => {
    const tx = pending();
    let now = tx.nextAttemptAt ?? T0;
    const delays: number[] = [];

    for (;;) {
      const decision = noJitter.decide(tx, now);
      if (decision.type === 'EXPIRE') {
        expect(decision.reason).toBe('MAX_ATTEMPTS');
        break;
      }
      delays.push((decision.nextAttemptAt.getTime() - now.getTime()) / SECOND);
      tx.scheduleReferenceRetry(decision.nextAttemptAt);
      now = decision.nextAttemptAt;
    }

    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60]);
    expect(tx.attempts).toBe(9);
    // tempo total até desistir ≈ 4 min 4 s: bem dentro do TTL de 15 min
    expect((now.getTime() - T0.getTime()) / SECOND).toBe(1 + 2 + 4 + 8 + 16 + 32 + 60 * 4);
  });

  it('UT-R03 TTL de 15 min expira mesmo com poucas tentativas (ex.: worker parado)', () => {
    const tx = pending();
    const afterOutage = plus(T0, 20 * 60 * SECOND);
    expect(noJitter.decide(tx, afterOutage)).toEqual({ type: 'EXPIRE', reason: 'TTL' });
  });

  it('UT-R04 jitter de até +20% evita que várias pendências acordem juntas', () => {
    const low = new ReferenceRetryPolicy({ random: () => 0 });
    const high = new ReferenceRetryPolicy({ random: () => 0.999_999 });
    const tx = pending();
    const now = plus(T0, SECOND);

    const delay = (policy: ReferenceRetryPolicy) => {
      const decision = policy.decide(tx, now);
      if (decision.type !== 'RETRY') throw new Error('esperava RETRY');
      return decision.nextAttemptAt.getTime() - now.getTime();
    };
    expect(delay(low)).toBe(2 * SECOND);
    expect(delay(high)).toBeGreaterThan(2 * SECOND);
    expect(delay(high)).toBeLessThanOrEqual(2.4 * SECOND);
  });

  it('UT-R05 ciclo completo: esgotado → REJECTED REFERENCE_NOT_FOUND + evento', () => {
    const tx = pending();
    let now = tx.nextAttemptAt ?? T0;
    for (;;) {
      const decision = noJitter.decide(tx, now);
      if (decision.type === 'EXPIRE') {
        tx.reject(FailureCode.ReferenceNotFound, { at: now, balanceAfter: brl('100.00') });
        break;
      }
      tx.scheduleReferenceRetry(decision.nextAttemptAt);
      now = decision.nextAttemptAt;
    }

    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    const event = WagerTransactionRejected.from(tx, {
      eventId: 'evt-expired',
      correlationId: 'corr',
      occurredAt: now,
    });
    expect(event.toJSON().data.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('UT-R06 rejeita configuração incoerente', () => {
    expect(() => new ReferenceRetryPolicy({ maxAttempts: 0 })).toThrow();
    expect(() => new ReferenceRetryPolicy({ baseDelayMs: 0 })).toThrow();
    expect(() => new ReferenceRetryPolicy({ maxDelayMs: 500, baseDelayMs: 1_000 })).toThrow();
    expect(() => new ReferenceRetryPolicy({ jitterRatio: 1.5 })).toThrow();
  });
});
