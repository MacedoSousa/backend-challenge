import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS } from '../../../src/shared/infrastructure/logging/logger';
import {
  currentContext,
  runWithContext,
} from '../../../src/shared/infrastructure/logging/request-context';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { logger, lines };
}

describe('logs sem dados sensíveis (§12)', () => {
  it('mascara valores monetários, payloads e credenciais', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer segredo', cookie: 'sessao=1' } },
        transaction: { money: { amount: '1000.00', currency: 'BRL' }, amount: '1000.00' },
        wallet: { balance: '975.00' },
        message: { payload: { playerId: 'p' } },
        provider: { token: 't', password: 'p', secret: 's' },
        body: { raw: 'conteúdo do corpo' },
        walletId: 'wallet-1',
      },
      'teste',
    );
    const [line] = lines;
    const text = JSON.stringify(line);
    for (const secret of ['segredo', 'sessao=1', '1000.00', '975.00', 'conteúdo do corpo']) {
      expect(text).not.toContain(secret);
    }
    expect(line?.walletId).toBe('wallet-1'); // identificadores operacionais continuam visíveis
  });

  it('o contexto da requisição (correlationId) entra em todo log', () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(String(chunk)));
        callback();
      },
    });
    const logger = pino({ mixin: () => ({ ...currentContext() }) }, stream);
    runWithContext({ correlationId: 'corr-42', messageId: 'msg-7' }, () => logger.info('x'));
    expect(lines[0]).toMatchObject({ correlationId: 'corr-42', messageId: 'msg-7' });
  });
});
