import { describe, expect, it } from 'bun:test';
import { APP_ROLES, InvalidEnvironmentError, loadEnv } from '../../../src/config/env';

const minimal = { DATABASE_URL: 'postgres://app:app@localhost:5432/wagering' };

describe('loadEnv', () => {
  it('aplica defaults seguros a partir do mínimo obrigatório', () => {
    const env = loadEnv(minimal);

    expect(env.PORT).toBe(3000);
    expect(env.APP_ROLE).toEqual([...APP_ROLES]);
    expect(env.SQS_WAGER_QUEUE).toBe('wager-transactions.fifo');
    expect(env.SQS_WAGER_DLQ).toBe('wager-transactions-dlq.fifo');
    expect(env.DB_POOL_MAX).toBe(10);
  });

  it('aceita uma lista de papéis de execução', () => {
    expect(loadEnv({ ...minimal, APP_ROLE: 'api, outbox' }).APP_ROLE).toEqual(['api', 'outbox']);
  });

  it('rejeita papel de execução desconhecido', () => {
    expect(() => loadEnv({ ...minimal, APP_ROLE: 'api,worker' })).toThrow(
      /papéis inválidos: worker/,
    );
  });

  it('falha rápido sem DATABASE_URL, listando o campo', () => {
    try {
      loadEnv({});
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvironmentError);
      expect((error as InvalidEnvironmentError).issues.join()).toContain('DATABASE_URL');
    }
  });

  it('rejeita URL de banco que não seja postgres', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      InvalidEnvironmentError,
    );
  });

  it('converte números vindos de string e valida limites', () => {
    expect(loadEnv({ ...minimal, PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadEnv({ ...minimal, PORT: '70000' })).toThrow(InvalidEnvironmentError);
  });
});
