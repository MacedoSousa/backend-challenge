import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  openingPayloadHash,
  payloadHash,
  type WagerPayload,
} from '../../../src/modules/wagering/domain/payload-hash';
import { InvalidMoneyError } from '../../../src/shared/domain/money';

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

  it('recusa valor fora da forma canônica (o contrato exige 2 casas)', () => {
    expect(() => payloadHash({ ...payload, money: { amount: '25', currency: 'BRL' } })).toThrow(
      InvalidMoneyError,
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

describe('hash da transação interna OPENING', () => {
  const money = { amount: '1000.00', currency: 'BRL' };

  it('é determinístico e muda com wallet, jogador ou valor', () => {
    const base = openingPayloadHash('wallet-1', 'player-1', money);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(openingPayloadHash('wallet-1', 'player-1', money)).toBe(base);
    expect(openingPayloadHash('wallet-2', 'player-1', money)).not.toBe(base);
    expect(openingPayloadHash('wallet-1', 'player-2', money)).not.toBe(base);
    expect(openingPayloadHash('wallet-1', 'player-1', { ...money, amount: '999.00' })).not.toBe(
      base,
    );
  });

  it('nunca colide com o hash de uma operação externa', () => {
    expect(openingPayloadHash('w', 'p', money)).not.toBe(payloadHash(payload));
  });
});
