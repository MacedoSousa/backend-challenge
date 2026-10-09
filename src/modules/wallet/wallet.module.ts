import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import {
  GetWalletUseCase,
  ListLedgerUseCase,
  ReconcileWalletUseCase,
} from './application/wallet-queries.use-case';
import { WalletController } from './presentation/http/wallet.controller';

@Module({
  controllers: [WalletController],
  providers: [CreateWalletUseCase, GetWalletUseCase, ListLedgerUseCase, ReconcileWalletUseCase],
})
export class WalletModule {}
