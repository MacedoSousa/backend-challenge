import { Migration } from '@mikro-orm/migrations';

/**
 * Iteração 8 — achado do teste de carga: o claim ordena por `(occurred_at, id)` e a métrica
 * de lag lê `min(occurred_at)` dos pendentes, mas o índice parcial era por `next_attempt_at`.
 * Com 80 mil pendentes, o claim ordenava tudo em disco (33 ms) e o lag fazia seq scan na
 * tabela inteira (49 ms, crescendo com o histórico). Com este índice: 2,8 ms e 0,05 ms.
 * `next_attempt_at` e o lease viram filtro sobre o índice já ordenado.
 */
export class Migration20261009500000_outbox_pending_index extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'CREATE INDEX ix_outbox_pending ON outbox_messages (occurred_at, id) WHERE published_at IS NULL;',
    );
    this.addSql('DROP INDEX ix_outbox_due;');
  }

  override async down(): Promise<void> {
    this.addSql(
      'CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;',
    );
    this.addSql('DROP INDEX ix_outbox_pending;');
  }
}
