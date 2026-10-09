import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(
  env: Pick<Env, 'AWS_REGION' | 'AWS_ENDPOINT_URL' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'>,
): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [APP_CONFIG], useFactory: (env: Env) => createSqsClient(env) },
    SqsClientLifecycle,
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
