import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  INSTANCE_ID,
  type RequestMeta,
  UNIQUE_WALLET_CONSTRAINT,
  UNIT_OF_WORK,
  UniqueConstraintViolation,
  type UnitOfWork,
} from '../../../shared/application/ports';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WagerTransactionProcessed } from '../../messaging/domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../../messaging/domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { openingPayloadHash } from '../../wagering/domain/payload-hash';
import { WagerTransaction, WagerTransactionStatus } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { WalletAlreadyExistsError } from './errors';
import { toWalletView, type WalletView } from './wallet-views';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Abre a wallet. Com saldo inicial > 0, na **mesma transação SQL**: wallet, transação
 * interna OPENING (PROCESSED), lançamento CREDIT e os eventos WagerTransactionProcessed e
 * WalletBalanceChanged na outbox (§9, §11).
 */
@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(INSTANCE_ID) private readonly instanceId: string,
  ) {}

  async execute(command: CreateWalletCommand, meta: RequestMeta): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      at: now,
      opening: { transactionId: this.ids.next(), entryId: this.ids.next() },
    });

    try {
      await this.uow.run(async (scope) => {
        scope.wallets.add(wallet);
        if (!openingEntry) return;

        const opening = WagerTransaction.createOpening({
          id: openingEntry.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          payloadHash: openingPayloadHash(wallet.id, wallet.playerId, initialBalance.toJSON()),
          createdAt: now,
        });
        opening.markProcessed({ at: now, balanceAfter: wallet.balance });
        scope.transactions.add(opening);
        scope.ledger.append(openingEntry);
        scope.audit.record({
          id: this.ids.next(),
          transactionId: opening.id,
          walletId: wallet.id,
          action: 'PROCESSED',
          fromStatus: WagerTransactionStatus.Pending,
          toStatus: opening.status,
          ledgerEntryId: openingEntry.id,
          source: 'INTERNAL',
          correlationId: meta.correlationId,
          instanceId: this.instanceId,
          occurredAt: now,
        });

        const context = { ...meta, occurredAt: now };
        scope.outbox.add(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(opening, { ...context, eventId: this.ids.next() }),
          ),
        );
        scope.outbox.add(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              ...context,
              eventId: this.ids.next(),
            }),
          ),
        );
      });
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolation &&
        error.constraint === UNIQUE_WALLET_CONSTRAINT
      ) {
        throw new WalletAlreadyExistsError(
          `o jogador já possui wallet em ${initialBalance.currency}`,
          { currency: initialBalance.currency },
        );
      }
      throw error;
    }
    return toWalletView(wallet);
  }
}
