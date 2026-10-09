import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import type { WagerTransaction } from '../../modules/wagering/domain/wager-transaction';
import type { Wallet } from '../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallet/domain/wallet-ledger-entry';
import type { Money } from '../domain/money';

export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): Date;
}

export const ID_GENERATOR = Symbol('ID_GENERATOR');
export interface IdGenerator {
  /** Identificador único e ordenável no tempo (UUID v7). */
  next(): string;
}

/** Metadados de rastreio que atravessam use case → eventos. */
export interface RequestMeta {
  correlationId: string;
  causationId?: string | undefined;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

export interface LedgerSummary {
  rebuiltBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): void;
  /** Lançamentos com walletVersion > afterVersion, em ordem crescente (cursor estável). */
  page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  /** Saldo reconstruído pelo ledger, somado no banco com NUMERIC (exato). */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  isolation?: 'READ_COMMITTED' | 'REPEATABLE_READ';
  readOnly?: boolean;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
/**
 * Fronteira transacional: tudo o que `work` registrar nos repositórios é confirmado
 * junto no COMMIT, ou nada é (inbox, financeiro, ledger e outbox — §6.5, §11).
 */
export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

/** Nome da constraint que garante uma wallet por jogador e moeda (migration da I2). */
export const UNIQUE_WALLET_CONSTRAINT = 'uq_wallet_player_currency';

/** Violação de unicidade traduzida da infraestrutura; o use case decide o significado. */
export class UniqueConstraintViolation extends Error {
  constructor(readonly constraint: string) {
    super(`violação de unicidade: ${constraint}`);
    this.name = 'UniqueConstraintViolation';
  }
}

export const APP_LOGGER = Symbol('APP_LOGGER');
export interface AppLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const METRICS = Symbol('METRICS');
/** Métricas de negócio exigidas pelo §12; cresce a cada iteração. */
export interface Metrics {
  reconciliation(result: 'consistent' | 'inconsistent'): void;
}
