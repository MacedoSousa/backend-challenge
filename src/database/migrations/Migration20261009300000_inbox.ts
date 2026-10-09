import { Migration } from '@mikro-orm/migrations';

/**
 * Iteração 5 — inbox do consumidor SQS (ADR-10): deduplicação persistente por
 * (consumer_name, message_id), gravada na mesma transação SQL dos efeitos.
 */
export class Migration20261009300000_inbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL CHECK (consumer_name <> ''),
        message_id    text        NOT NULL CHECK (message_id <> ''),
        payload_hash  char(64)    NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE inbox_messages;');
  }
}
