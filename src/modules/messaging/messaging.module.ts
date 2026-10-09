import { Module } from '@nestjs/common';
import { MESSAGE_PUBLISHER, OUTBOX_STORE, RETENTION_STORE } from '../../shared/application/ports';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case';
import { OutboxPublisherWorker } from './infrastructure/outbox-publisher.worker';
import { QueueDepthWorker } from './infrastructure/queue-depth.worker';
import { RetentionWorker, SqlRetentionStore } from './infrastructure/retention';
import { SqlOutboxStore } from './infrastructure/sql-outbox-store';
import { SqsMessagePublisher } from './infrastructure/sqs-message-publisher';

@Module({
  providers: [
    { provide: OUTBOX_STORE, useClass: SqlOutboxStore },
    { provide: MESSAGE_PUBLISHER, useClass: SqsMessagePublisher },
    PublishOutboxUseCase,
    OutboxPublisherWorker,
    { provide: RETENTION_STORE, useClass: SqlRetentionStore },
    RetentionWorker,
    QueueDepthWorker,
  ],
  exports: [RetentionWorker, QueueDepthWorker],
})
export class MessagingModule {}
