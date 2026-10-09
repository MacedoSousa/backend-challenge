import type { AuditEntry } from '../../../shared/application/ports';
import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';

/** Resultado de uma submissão, igual na primeira vez e em todo replay (regra 7). */
export interface WagerResultView {
  transactionId: string;
  status: string;
  /** Saldo observado na decisão; `null` enquanto aguarda a referência. */
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: string;
  relatedTransactionId?: string;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  relatedTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface AuditEntryView {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  failureCode: string | null;
  ledgerEntryId: string | null;
  relatedTransactionId: string | null;
  source: string;
  correlationId: string;
  messageId: string | null;
  instanceId: string;
  details: Record<string, unknown>;
  occurredAt: string;
}

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResultView {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.balanceAfter?.toJSON() ?? null,
    idempotentReplay,
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.relatedTransactionId ? { relatedTransactionId: tx.relatedTransactionId } : {}),
  };
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId ?? null,
    gameId: tx.gameId ?? null,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    relatedTransactionId: tx.relatedTransactionId ?? null,
    balanceAfter: tx.balanceAfter?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function toAuditEntryView(entry: AuditEntry): AuditEntryView {
  return {
    id: entry.id,
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
    occurredAt: entry.occurredAt.toISOString(),
  };
}
