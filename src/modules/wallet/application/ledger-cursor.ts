import { RequestValidationError } from '../../../shared/application/errors';

const PREFIX = 'v1:';

/**
 * Cursor opaco e estável do ledger (ADR-15): codifica a última `walletVersion` entregue.
 * Como a versão só cresce, novas entradas aparecem no fim e nunca deslocam páginas já lidas.
 */
export const LedgerCursor = {
  encode(walletVersion: number): string {
    return Buffer.from(`${PREFIX}${walletVersion}`, 'utf8').toString('base64url');
  },

  /** `undefined` = início do ledger. */
  decode(cursor: string | undefined): number {
    if (cursor === undefined || cursor === '') return 0;
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^v1:(\d{1,10})$/.exec(decoded);
    if (!match?.[1]) {
      throw new RequestValidationError('cursor inválido', { field: 'cursor' });
    }
    return Number.parseInt(match[1], 10);
  },
};
