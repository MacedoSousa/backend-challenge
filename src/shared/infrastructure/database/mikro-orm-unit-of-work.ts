import {
  ConnectionException,
  IsolationLevel,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { InboxMessage } from '../../../modules/messaging/domain/inbox-message';
import type { OutboxMessage } from '../../../modules/messaging/domain/outbox-message';
import type { WagerTransaction } from '../../../modules/wagering/domain/wager-transaction';
import type { Wallet } from '../../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../../modules/wallet/domain/wallet-ledger-entry';
import { InfrastructureUnavailableError, LockTimeoutError } from '../../application/errors';
import {
  type AuditEntry,
  type AuditRepository,
  type InboxRegistration,
  type InboxRepository,
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
import {
  AuditMapper,
  LedgerEntryMapper,
  OutboxMapper,
  WagerTransactionMapper,
  WalletMapper,
} from './mappers';
import { AuditRecord, LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

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
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

/**
 * Unit of Work sobre o MikroORM: cada execução usa um EntityManager novo (fork) e uma
 * transação própria, com `lock_timeout`/`statement_timeout` locais; o flush acontece
 * antes do COMMIT, então tudo é confirmado junto (ADR-27).
 */
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options: UnitOfWorkOptions = {}) {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // SET LOCAL vale só para esta transação: compatível com pooler (ADR, S-5)
          await em.execute(
            `SET LOCAL lock_timeout = ${this.env.DB_LOCK_TIMEOUT_MS};
             SET LOCAL statement_timeout = ${this.env.DB_STATEMENT_TIMEOUT_MS}`,
          );
          return work(createScope(em));
        },
        {
          isolationLevel:
            options.isolation === 'REPEATABLE_READ'
              ? IsolationLevel.REPEATABLE_READ
              : IsolationLevel.READ_COMMITTED,
          ...(options.readOnly ? { readOnly: true } : {}),
        },
      );
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
  if (error instanceof LockWaitTimeoutException || code === '55P03') {
    return new LockTimeoutError('tempo de espera pelo lock da wallet esgotado', { cause: '55P03' });
  }
  const isTransient =
    error instanceof ConnectionException ||
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
    audit: new MikroOrmAuditRepository(em),
    inbox: new SqlInboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  /** Registros gerenciados pelo Unit of Work, para que `save` vire um UPDATE no flush. */
  private readonly managed = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string) {
    return this.toDomain(await this.em.findOne(WalletRecord, { id }));
  }

  async lockById(id: string) {
    return this.toDomain(
      await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE }),
    );
  }

  add(wallet: Wallet): void {
    this.em.persist(WalletMapper.assign(wallet));
  }

  save(wallet: Wallet): void {
    const record = this.managed.get(wallet.id);
    if (!record) throw new Error(`wallet ${wallet.id} não foi carregada nesta transação`);
    WalletMapper.assign(wallet, record);
  }

  private toDomain(record: WalletRecord | null) {
    if (!record) return undefined;
    this.managed.set(record.id, record);
    return WalletMapper.toDomain(record);
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): void {
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
  private readonly managed = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  add(transaction: WagerTransaction): void {
    const record = this.em.create(
      WagerTransactionRecord,
      WagerTransactionMapper.toRecord(transaction),
    );
    this.managed.set(record.id, record);
    this.em.persist(record);
  }

  save(transaction: WagerTransaction): void {
    const record = this.managed.get(transaction.id);
    if (!record) throw new Error(`transação ${transaction.id} não foi carregada nesta transação`);
    WagerTransactionMapper.assign(transaction, record);
  }

  async findById(id: string) {
    return this.toDomain(await this.em.findOne(WagerTransactionRecord, { id }));
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    return this.toDomain(await this.em.findOne(WagerTransactionRecord, { idempotencyKey }));
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
    options: { lock?: boolean } = {},
  ) {
    return this.toDomain(
      await this.em.findOne(
        WagerTransactionRecord,
        { providerId, externalTransactionId },
        options.lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {},
      ),
    );
  }

  async findProcessedReversalOf(referenceTransactionId: string) {
    return this.toDomain(
      await this.em.findOne(WagerTransactionRecord, {
        referenceTransactionId,
        kind: { $in: ['REFUND', 'ROLLBACK'] },
        status: 'PROCESSED',
      }),
    );
  }

  async wakeDependents(providerId: string, externalTransactionId: string, at: Date) {
    await this.em.execute(
      `UPDATE wager_transactions SET next_attempt_at = ?
        WHERE status = 'PENDING_REFERENCE'
          AND provider_id = ? AND reference_external_transaction_id = ?
          AND next_attempt_at > ?`,
      [at, providerId, externalTransactionId, at],
    );
  }

  private toDomain(record: WagerTransactionRecord | null) {
    if (!record) return undefined;
    this.managed.set(record.id, record);
    return WagerTransactionMapper.toDomain(record);
  }
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(message: InboxMessage): Promise<InboxRegistration> {
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    if (inserted.length > 0) return { status: 'NEW' };

    const [row] = await this.em.execute<
      { payload_hash: string; received_at: string; processed_at: string | null }[]
    >(
      `SELECT payload_hash, received_at, processed_at FROM inbox_messages
        WHERE consumer_name = ? AND message_id = ?`,
      [message.consumerName, message.messageId],
    );
    return {
      status: 'DUPLICATE',
      existing: InboxMessage.rehydrate({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: row?.payload_hash ?? '',
        receivedAt: new Date(row?.received_at ?? message.receivedAt),
        processedAt: row?.processed_at ? new Date(row.processed_at) : undefined,
      }),
    };
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(OutboxMapper.toRecord(message));
  }
}

class MikroOrmAuditRepository implements AuditRepository {
  constructor(private readonly em: EntityManager) {}

  record(entry: AuditEntry): void {
    this.em.persist(AuditMapper.toRecord(entry));
  }

  async timeline(transactionId: string): Promise<AuditEntry[]> {
    const records = await this.em.find(
      AuditRecord,
      { transactionId },
      { orderBy: { occurredAt: 'asc', id: 'asc' } },
    );
    return records.map(AuditMapper.toEntry);
  }
}

/** Soma do ledger pode ser negativa só em dados corrompidos; preserva o sinal sem `number`. */
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
