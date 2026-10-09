import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { RequestMeta } from '../../../../shared/application/ports';
import { Meta } from '../../../../shared/presentation/http/request-meta.decorator';
import { ZodValidationPipe } from '../../../../shared/presentation/http/zod-validation.pipe';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import {
  GetWalletUseCase,
  ListLedgerUseCase,
  ReconcileWalletUseCase,
} from '../../application/wallet-queries.use-case';
import type {
  LedgerPageView,
  ReconciliationView,
  WalletView,
} from '../../application/wallet-views';

/** Forma do dinheiro na borda; o conteúdo (escala, sinal, moeda) é validado pelo Money. */
const MoneySchema = z.object({ amount: z.string(), currency: z.string() }).strict();

const CreateWalletBody = z.object({ playerId: z.uuid(), initialBalance: MoneySchema }).strict();

const WalletIdParam = z.uuid();

const LedgerQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(CreateWalletBody)) body: z.output<typeof CreateWalletBody>,
    @Meta() meta: RequestMeta,
  ): Promise<WalletView> {
    return this.createWallet.execute(body, meta);
  }

  @Get(':walletId')
  get(@Param('walletId', new ZodValidationPipe(WalletIdParam)) walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ZodValidationPipe(WalletIdParam)) walletId: string,
    @Query(new ZodValidationPipe(LedgerQuery)) query: z.output<typeof LedgerQuery>,
  ): Promise<LedgerPageView> {
    return this.listLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param('walletId', new ZodValidationPipe(WalletIdParam)) walletId: string,
  ): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(walletId);
  }
}
