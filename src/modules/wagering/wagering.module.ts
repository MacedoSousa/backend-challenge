import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PENDING_REFERENCE_STORE } from '../../shared/application/ports';
import { ProcessWagerTransactionUseCase } from './application/process-wager-transaction.use-case';
import { ResolvePendingReferencesUseCase } from './application/resolve-pending-references.use-case';
import {
  GetTransactionAuditUseCase,
  GetTransactionUseCase,
} from './application/transaction-queries.use-case';
import { WagerProcessor } from './application/wager-processor';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy';
import {
  PendingReferenceWorker,
  SqlPendingReferenceStore,
} from './infrastructure/pending-references';
import { WageringController } from './presentation/http/wagering.controller';
import { WagerTransactionConsumer } from './presentation/sqs/wager-transaction.consumer';

@Module({
  controllers: [WageringController],
  providers: [
    {
      provide: ReferenceRetryPolicy,
      inject: [APP_CONFIG],
      useFactory: (env: Env) =>
        new ReferenceRetryPolicy({
          baseDelayMs: env.REFERENCE_RETRY_BASE_MS,
          maxDelayMs: env.REFERENCE_RETRY_MAX_DELAY_MS,
          maxAttempts: env.REFERENCE_RETRY_MAX_ATTEMPTS,
          ttlMs: env.REFERENCE_RETRY_TTL_MS,
        }),
    },
    { provide: PENDING_REFERENCE_STORE, useClass: SqlPendingReferenceStore },
    WagerProcessor,
    ProcessWagerTransactionUseCase,
    ResolvePendingReferencesUseCase,
    GetTransactionUseCase,
    GetTransactionAuditUseCase,
    PendingReferenceWorker,
    WagerTransactionConsumer,
  ],
})
export class WageringModule {}
