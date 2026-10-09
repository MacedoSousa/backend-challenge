import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PinoNestLogger, REDACT_PATHS } from '../../../src/shared/infrastructure/logging/logger';
import {
  currentContext,
  enrichContext,
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

describe('adaptador de log do NestJS', () => {
  it('mapeia cada nível do Nest para o nível equivalente do pino, com o contexto', () => {
    const { logger, lines } = capture();
    logger.level = 'trace';
    const nest = new PinoNestLogger(logger);
    nest.log('subiu', 'Bootstrap');
    nest.warn('atenção', 'Consumer');
    nest.error('falhou', 'stack…', 'Outbox');
    nest.debug('detalhe', 'Worker');
    nest.verbose('ruído', 'Worker');
    expect(lines.map((l) => [l.level, l.msg, l.context])).toEqual([
      [30, 'subiu', 'Bootstrap'],
      [40, 'atenção', 'Consumer'],
      [50, 'falhou', 'Outbox'],
      [20, 'detalhe', 'Worker'],
      [10, 'ruído', 'Worker'],
    ]);
    expect(lines[2]?.trace).toBe('stack…');
  });
});

describe('contexto da requisição', () => {
  it('enrichContext acrescenta campos ao contexto corrente e é no-op fora de um contexto', () => {
    enrichContext({ walletId: 'fora' }); // sem contexto: não lança
    expect(currentContext()).toBeUndefined();
    runWithContext({ correlationId: 'c-1' }, () => {
      enrichContext({ walletId: 'w-1', transactionId: 't-1' });
      expect(currentContext()).toEqual({
        correlationId: 'c-1',
        walletId: 'w-1',
        transactionId: 't-1',
      });
    });
  });
});
