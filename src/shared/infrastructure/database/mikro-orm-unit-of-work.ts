import {
  ConnectionException,
  IsolationLevel,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InfrastructureUnavailableError } from '../../application/errors';
import {
  type LedgerPage,
  type LedgerRepository,
  type LedgerSummary,
  type OutboxRepository,
  type TransactionScope,
  UniqueConstraintViolation,
  type UnitOfWork,
  type UnitOfWorkOptions,
  type WagerTransactionRepository,
  type WalletRepository,
} from '../../application/ports';
import { Money } from '../../domain/money';
import { LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

/** Erros do Postgres/rede que indicam indisponibilidade temporária (o cliente pode reenviar). */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

/**
 * Unit of Work sobre o MikroORM: cada execução usa um EntityManager novo (fork) e uma
 * transação própria; o flush acontece antes do COMMIT, então tudo é confirmado junto.
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}) {
    try {
      return await this.orm.em.fork().transactional((em) => work(createScope(em)), {
        isolationLevel:
          options.isolation === 'REPEATABLE_READ'
            ? IsolationLevel.REPEATABLE_READ
            : IsolationLevel.READ_COMMITTED,
        ...(options.readOnly ? { readOnly: true } : {}),
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new UniqueConstraintViolation(
      (error as UniqueConstraintViolationException & { constraint?: string }).constraint ?? '',
    );
  }
  const code = (error as { code?: string } | undefined)?.code;
  const isTransient =
    error instanceof ConnectionException ||
    error instanceof LockWaitTimeoutException ||
    (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) ||
    (error instanceof Error && error.name === 'KnexTimeoutError');
  if (isTransient) {
    return new InfrastructureUnavailableError('banco de dados temporariamente indisponível', {
      cause: code ?? (error as Error).name,
    });
  }
  return error;
}

function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string) {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  add(wallet: Parameters<WalletRepository['add']>[0]): void {
    this.em.persist(WalletMapper.assign(wallet));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: Parameters<LedgerRepository['append']>[0]): void {
    this.em.persist(this.em.create(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry)));
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
    );
    return {
      entries: records.slice(0, limit).map(LedgerEntryMapper.toDomain),
      hasMore: records.length > limit,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<{ rebuilt: string; entries: number }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
                ::numeric(20,2)::text AS rebuilt,
              count(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      rebuiltBalance: signedMoney(row?.rebuilt ?? '0.00', currency),
      entries: row?.entries ?? 0,
    };
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  add(transaction: Parameters<WagerTransactionRepository['add']>[0]): void {
    this.em.persist(
      this.em.create(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction)),
    );
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: Parameters<OutboxRepository['add']>[0]): void {
    this.em.persist(OutboxMapper.toRecord(message));
  }
}

/** Soma do ledger pode ser negativa só em dados corrompidos; preserva o sinal sem `number`. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
