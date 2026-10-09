import { EntitySchema } from '@mikro-orm/core';

/**
 * Registros de persistência (linhas do banco), separados do domínio (ADR-01).
 * Mapeados com EntitySchema — sem decorators — e reidratados no domínio via mappers.
 * Valores monetários trafegam como string (`decimal` em modo string), nunca `number`.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId?: string | null;
  gameId?: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  relatedTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', length: 64 },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string', nullable: true },
    gameId: { type: 'string', nullable: true },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    relatedTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    balanceAfter: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      runtimeType: 'string',
      nullable: true,
    },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  walletVersion!: number;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    currency: { type: 'string', length: 3 },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    createdAt: { type: 'datetime' },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedUntil?: Date | null;
  lockedBy?: string | null;
  publishedAt?: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime' },
    lockedUntil: { type: 'datetime', nullable: true },
    lockedBy: { type: 'string', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  OutboxSchema,
];
