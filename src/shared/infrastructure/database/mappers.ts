import type { OutboxMessage } from '../../../modules/messaging/domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../../modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../modules/wallet/domain/wallet';
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from '../../../modules/wallet/domain/wallet-ledger-entry';
import type { AuditEntry } from '../../application/ports';
import type { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import {
  AuditRecord,
  type LedgerEntryRecord,
  OutboxRecord,
  type WagerTransactionRecord,
  WalletRecord,
} from './records';

const money = (amount: string, currency: string) => Money.from({ amount, currency });

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  /** Copia o estado do domínio para o registro (novo ou já gerenciado pelo Unit of Work). */
  assign(wallet: Wallet, record: WalletRecord = new WalletRecord()): WalletRecord {
    record.id = wallet.id;
    record.playerId = wallet.playerId;
    record.currency = wallet.currency;
    record.balance = wallet.balance.toJSON().amount;
    record.version = wallet.version;
    record.createdAt = wallet.createdAt;
    record.updatedAt = wallet.updatedAt;
    return record;
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      walletVersion: record.walletVersion,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: money(record.amount, record.currency),
      balanceBefore: money(record.balanceBefore, record.currency),
      balanceAfter: money(record.balanceAfter, record.currency),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      walletVersion: entry.walletVersion,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const optionalMoney = (amount: string | null | undefined) =>
      amount === null || amount === undefined ? undefined : money(amount, record.currency);
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId ?? undefined,
      gameId: record.gameId ?? undefined,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      relatedTransactionId: record.relatedTransactionId ?? undefined,
      failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
      processedAt: record.processedAt ?? undefined,
      balanceAfter: optionalMoney(record.balanceAfter),
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
    });
  },

  /** Copia o estado do domínio para um registro já gerenciado pelo Unit of Work. */
  assign(transaction: WagerTransaction, record: WagerTransactionRecord): WagerTransactionRecord {
    return Object.assign(record, WagerTransactionMapper.toRecord(transaction));
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    const state = transaction.toState();
    return {
      id: state.id,
      providerId: state.providerId,
      externalTransactionId: state.externalTransactionId,
      idempotencyKey: state.idempotencyKey,
      payloadHash: state.payloadHash,
      walletId: state.walletId,
      playerId: state.playerId,
      roundId: state.roundId ?? null,
      gameId: state.gameId ?? null,
      kind: state.kind,
      amount: state.money.toJSON().amount,
      currency: state.money.currency,
      referenceExternalTransactionId: state.referenceExternalTransactionId ?? null,
      referenceTransactionId: state.referenceTransactionId ?? null,
      relatedTransactionId: state.relatedTransactionId ?? null,
      status: state.status,
      failureCode: state.failureCode ?? null,
      balanceAfter: state.balanceAfter?.toJSON().amount ?? null,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt ?? null,
      createdAt: state.createdAt,
      processedAt: state.processedAt ?? null,
    };
  },
};

export const OutboxMapper = {
  toRecord(message: OutboxMessage): OutboxRecord {
    const record = new OutboxRecord();
    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? message.occurredAt;
    record.publishedAt = message.publishedAt ?? null;
    return record;
  },
};

export const AuditMapper = {
  toRecord(entry: AuditEntry): AuditRecord {
    return Object.assign(new AuditRecord(), {
      id: entry.id,
      transactionId: entry.transactionId,
      walletId: entry.walletId,
      action: entry.action,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      failureCode: entry.failureCode ?? null,
      ledgerEntryId: entry.ledgerEntryId ?? null,
      relatedTransactionId: entry.relatedTransactionId ?? null,
      source: entry.source,
      correlationId: entry.correlationId,
      messageId: entry.messageId ?? null,
      instanceId: entry.instanceId,
      details: entry.details ?? {},
      occurredAt: entry.occurredAt,
    });
  },

  toEntry(record: AuditRecord): AuditEntry {
    return {
      id: record.id,
      transactionId: record.transactionId,
      walletId: record.walletId,
      action: record.action as AuditEntry['action'],
      fromStatus: (record.fromStatus ?? undefined) as AuditEntry['fromStatus'],
      toStatus: (record.toStatus ?? undefined) as AuditEntry['toStatus'],
      failureCode: (record.failureCode ?? undefined) as AuditEntry['failureCode'],
      ledgerEntryId: record.ledgerEntryId ?? undefined,
      relatedTransactionId: record.relatedTransactionId ?? undefined,
      source: record.source as AuditEntry['source'],
      correlationId: record.correlationId,
      messageId: record.messageId ?? undefined,
      instanceId: record.instanceId,
      details: record.details,
      occurredAt: record.occurredAt,
    };
  },
};
