import type { OutboxMessage } from '../../../modules/messaging/domain/outbox-message';
import type { WagerTransaction } from '../../../modules/wagering/domain/wager-transaction';
import { Wallet } from '../../../modules/wallet/domain/wallet';
import {
  type LedgerDirection,
  WalletLedgerEntry,
} from '../../../modules/wallet/domain/wallet-ledger-entry';
import { Money } from '../../domain/money';
import {
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
