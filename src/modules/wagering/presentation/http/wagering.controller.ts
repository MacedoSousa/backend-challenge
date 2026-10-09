import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { RequestMeta } from '../../../../shared/application/ports';
import { Meta } from '../../../../shared/presentation/http/request-meta.decorator';
import { ZodValidationPipe } from '../../../../shared/presentation/http/zod-validation.pipe';
import { ProcessWagerTransactionUseCase } from '../../application/process-wager-transaction.use-case';
import {
  GetTransactionAuditUseCase,
  GetTransactionUseCase,
} from '../../application/transaction-queries.use-case';
import type { WagerResultView } from '../../application/transaction-views';
import { IdempotencyKey, WagerTransactionBody } from '../wager-contract';

const idempotencyKeyPipe = new ZodValidationPipe(IdempotencyKey);

const TransactionIdParam = z.uuid();
const ProviderParam = z.string().min(1).max(100);
const ExternalIdParam = z.string().min(1).max(200);

/** Mapeamento HTTP do resultado (docs/01 §8). Rejeição de negócio é problem+json 422. */
const SUCCESS_STATUS: Record<string, (replay: boolean) => number> = {
  PROCESSED: (replay) => (replay ? HttpStatus.OK : HttpStatus.CREATED),
  PENDING_REFERENCE: () => HttpStatus.ACCEPTED,
};

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
    private readonly getAudit: GetTransactionAuditUseCase,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(WagerTransactionBody)) body: z.output<typeof WagerTransactionBody>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResultView | Record<string, unknown>> {
    // @Headers não aceita pipes: o header é validado aqui, com o mesmo contrato de erro (400)
    const idempotencyKey = idempotencyKeyPipe.transform(rawIdempotencyKey);
    const result = await this.processWager.execute(
      { ...body, idempotencyKey },
      { ...meta, source: 'HTTP' },
    );

    const success = SUCCESS_STATUS[result.status];
    if (success) {
      res.status(success(result.idempotentReplay));
      return result;
    }
    // REJECTED / FAILED: problem details com o resultado persistido como extensão (RFC 9457)
    const { status: transactionStatus, ...rest } = result;
    res.status(HttpStatus.UNPROCESSABLE_ENTITY).type('application/problem+json');
    return {
      type: `urn:wagering:problem:${(result.failureCode ?? 'rejected').toLowerCase()}`,
      title: result.failureCode ?? 'REJECTED',
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      correlationId: meta.correlationId,
      transactionStatus,
      ...rest,
    };
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ZodValidationPipe(TransactionIdParam)) transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get('wagering/transactions/:transactionId/audit')
  audit(@Param('transactionId', new ZodValidationPipe(TransactionIdParam)) transactionId: string) {
    return this.getAudit.execute(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProviderExternal(
    @Param('providerId', new ZodValidationPipe(ProviderParam)) providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(ExternalIdParam))
    externalTransactionId: string,
  ) {
    return this.getTransaction.byProviderExternal(providerId, externalTransactionId);
  }
}
