import { describe, expect, it } from 'bun:test';
import {
  InfrastructureUnavailableError,
  LockTimeoutError,
} from '../../../src/shared/application/errors';
import { UniqueConstraintViolation } from '../../../src/shared/application/ports';
import { translateDriverError } from '../../../src/shared/infrastructure/database/mikro-orm-unit-of-work';

const driverError = (code: string, message = 'falha') =>
  Object.assign(new Error(message), { code });

/**
 * Bug achado pela suíte de evidências (A11): com o Postgres parado, o DNS do Docker deixa de
 * resolver `postgres` e o driver lança `getaddrinfo ETIMEOUT` — que virava 500. Toda falha
 * de rede/resolução precisa virar INFRA_UNAVAILABLE (503 + Retry-After): o provedor reenvia.
 */
describe('tradução de erros do banco', () => {
  it.each([
    ['ETIMEOUT', 'resolução de nome expirou (container parado)'],
    ['ENOTFOUND', 'nome não existe no DNS'],
    ['EAI_AGAIN', 'DNS temporariamente indisponível'],
    ['ECONNREFUSED', 'conexão recusada'],
    ['ECONNRESET', 'conexão derrubada'],
    ['EHOSTUNREACH', 'host inalcançável'],
    ['ENETUNREACH', 'rede inalcançável'],
    ['57P01', 'Postgres em shutdown'],
    ['08006', 'falha de conexão (classe 08)'],
    ['53300', 'conexões esgotadas'],
  ])('%s (%s) → indisponibilidade temporária', (code) => {
    expect(translateDriverError(driverError(code))).toBeInstanceOf(InfrastructureUnavailableError);
  });

  it('lock_timeout (55P03) → LockTimeoutError (métrica própria de hot wallet)', () => {
    expect(translateDriverError(driverError('55P03'))).toBeInstanceOf(LockTimeoutError);
  });

  it('erros de programação não são mascarados como indisponibilidade', () => {
    const bug = new TypeError('undefined is not a function');
    expect(translateDriverError(bug)).toBe(bug);
    const syntax = driverError('42601');
    expect(translateDriverError(syntax)).toBe(syntax);
  });

  it('unicidade vira UniqueConstraintViolation com o nome da constraint', async () => {
    const { UniqueConstraintViolationException } = await import('@mikro-orm/core');
    const error = new UniqueConstraintViolationException(
      Object.assign(new Error('duplicate key'), { constraint: 'uq_tx_idempotency_key' }),
    );
    const translated = translateDriverError(error);
    expect(translated).toBeInstanceOf(UniqueConstraintViolation);
    expect((translated as UniqueConstraintViolation).constraint).toBe('uq_tx_idempotency_key');
  });
});
