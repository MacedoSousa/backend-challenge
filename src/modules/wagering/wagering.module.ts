import { Module } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import {
  GetTransactionAuditUseCase,
  GetTransactionUseCase,
} from './application/transaction-queries.use-case';
import { WagerProcessor } from './application/wager-processor';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import { WageringController } from './presentation/http/wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [
    { provide: ReferenceRetryPolicy, useFactory: () => new ReferenceRetryPolicy() },
    WagerProcessor,
    ProcessWagerTransactionUseCase,
    GetTransactionUseCase,
    GetTransactionAuditUseCase,
  ],
  exports: [WagerProcessor, ProcessWagerTransactionUseCase],
})
export class WageringModule {}
