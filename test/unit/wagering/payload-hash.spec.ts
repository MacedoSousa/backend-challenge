import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  payloadHash,
  type WagerPayload,
} from '../../../src/modules/wagering/domain/payload-hash';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('UT-T09 payloadHash canônico', () => {
  it('é SHA-256 hexadecimal', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('não depende da ordem das chaves', () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as WagerPayload;
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });

  it('normaliza o valor monetário ("25" ≡ "25.00")', () => {
    expect(payloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } })).toBe(
      payloadHash(payload),
    );
  });

  it('ignora campos fora do subconjunto de negócio (header, metadados de transporte)', () => {
    const withTransport = { ...payload, idempotencyKey: 'x', messageId: 'm', occurredAt: 'now' };
    expect(payloadHash(withTransport as WagerPayload)).toBe(payloadHash(payload));
  });

  it('referência ausente e undefined produzem o mesmo hash', () => {
    expect(payloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      payloadHash(payload),
    );
  });

  it.each([
    ['valor', { money: { amount: '10.00', currency: 'BRL' } }],
    ['kind', { kind: 'WIN' }],
    ['rodada', { roundId: 'round-988' }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('muda quando %s muda', (_field, override) => {
    expect(payloadHash({ ...payload, ...override } as WagerPayload)).not.toBe(payloadHash(payload));
  });

  it('o JSON canônico é estável e documentável', () => {
    expect(canonicalJson(payload)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
        '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
  });
});
