import type { OutboxMessage } from '../../modules/messaging/domain/outbox-message';
import type {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../modules/wagering/domain/wager-transaction';
import type { Wallet } from '../../modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../modules/wallet/domain/wallet-ledger-entry';
import type { FailureCode } from '../domain/failure-code';
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

/** Canal que originou a decisão (registrado na auditoria). */
export type Source = 'HTTP' | 'SQS' | 'WORKER' | 'INTERNAL';

/** Metadados de rastreio que atravessam use case → eventos → auditoria. */
export interface RequestMeta {
  correlationId: string;
  causationId?: string | undefined;
  source?: Source | undefined;
  /** messageId do SQS, quando a entrada veio da fila. */
  messageId?: string | undefined;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** `SELECT … FOR UPDATE`: serializa todas as operações da wallet (ADR-03). */
  lockById(id: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  /** Persiste a mudança de saldo/versão de uma wallet obtida por `lockById`. */
  save(wallet: Wallet): void;
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
  /** Persiste a mudança de estado de uma transação já existente. */
  save(transaction: WagerTransaction): void;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  /** `lock` = `FOR UPDATE` (referência de uma reversão, sempre depois do lock da wallet). */
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
    options?: { lock?: boolean },
  ): Promise<WagerTransaction | undefined>;
  /** Reversão (REFUND ou ROLLBACK) PROCESSED que já aponta para a referência. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}

export type AuditAction =
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'RETRY_SCHEDULED'
  | 'FAILED'
  | 'IDEMPOTENT_REPLAY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVERSED_BY';

/** Uma decisão sobre uma transação (D-18): o "o que aconteceu" ao lado do "para onde foi". */
export interface AuditEntry {
  id: string;
  transactionId: string;
  walletId: string;
  action: AuditAction;
  fromStatus?: WagerTransactionStatus | undefined;
  toStatus?: WagerTransactionStatus | undefined;
  failureCode?: FailureCode | undefined;
  ledgerEntryId?: string | undefined;
  relatedTransactionId?: string | undefined;
  source: Source;
  correlationId: string;
  messageId?: string | undefined;
  instanceId: string;
  details?: Record<string, unknown> | undefined;
  occurredAt: Date;
}

export interface AuditRepository {
  record(entry: AuditEntry): void;
  timeline(transactionId: string): Promise<AuditEntry[]>;
}

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionScope {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  audit: AuditRepository;
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

export type DuplicateType = 'idempotent_replay' | 'payload_conflict' | 'key_mismatch';

export const METRICS = Symbol('METRICS');
/** Métricas de negócio exigidas pelo §12; cresce a cada iteração. */
export interface Metrics {
  reconciliation(result: 'consistent' | 'inconsistent'): void;
  transaction(labels: { kind: string; status: string; source: Source }, seconds: number): void;
  duplicate(labels: { source: Source; type: DuplicateType }): void;
  /** Tempo de espera pelo lock da wallet; espera relevante conta como conflito de lock. */
  lockWait(seconds: number): void;
  lockTimeout(): void;
  error(labels: { category: string; failureCode: string }): void;
}

export const INSTANCE_ID = Symbol('INSTANCE_ID');

export const PLAYER_SESSION_POLICY = Symbol('PLAYER_SESSION_POLICY');
/**
 * Ponto de extensão (D-19, ADR-24): "um jogo por vez" é responsabilidade da plataforma.
 * A implementação padrão permite tudo; uma restritiva rejeitaria com
 * CONCURRENT_GAME_NOT_ALLOWED sem mudar o use case.
 */
export interface PlayerSessionPolicy {
  canBet(input: { playerId: string; gameId: string; roundId: string }): Promise<boolean>;
}

export const FAULT_INJECTOR = Symbol('FAULT_INJECTOR');
/** Pontos de falha nomeados, ativos só em teste (docs/04 §5); no-op em produção. */
export interface FaultInjector {
  trigger(point: string): void;
}
