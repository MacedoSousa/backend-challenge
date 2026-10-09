import { Migration } from '@mikro-orm/migrations';

/**
 * Iteração 8 — índices da retenção (S-2): sem eles cada rodada do job fazia seq scan com
 * FOR UPDATE nas duas tabelas. Parciais: só as linhas elegíveis entram no índice.
 */
export class Migration20261009400000_retention_indexes extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'CREATE INDEX ix_outbox_published_at ON outbox_messages (published_at) WHERE published_at IS NOT NULL;',
    );
    this.addSql(
      'CREATE INDEX ix_inbox_processed_at ON inbox_messages (processed_at) WHERE processed_at IS NOT NULL;',
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP INDEX ix_inbox_processed_at;');
    this.addSql('DROP INDEX ix_outbox_published_at;');
  }
}
