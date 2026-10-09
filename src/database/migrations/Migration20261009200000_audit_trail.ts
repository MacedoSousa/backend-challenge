import { Migration } from '@mikro-orm/migrations';

/**
 * Iteração 3 — trilha de auditoria (D-18, ADR-19): uma linha por decisão sobre uma
 * transação, gravada na mesma transação SQL da decisão. Append-only como o ledger.
 */
export class Migration20261009200000_audit_trail extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wager_transaction_audit (
        id                     uuid        PRIMARY KEY,
        transaction_id         uuid        NOT NULL
                               REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        wallet_id              uuid        NOT NULL
                               REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        action                 text        NOT NULL CHECK (action IN (
                                 'PROCESSED','REJECTED','PENDING_REFERENCE','RETRY_SCHEDULED',
                                 'FAILED','IDEMPOTENT_REPLAY','IDEMPOTENCY_CONFLICT','REVERSED_BY')),
        from_status            text,
        to_status              text,
        failure_code           text,
        ledger_entry_id        uuid
                               REFERENCES wallet_ledger_entries(id) DEFERRABLE INITIALLY DEFERRED,
        related_transaction_id uuid
                               REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        source                 text        NOT NULL CHECK (source IN ('HTTP','SQS','WORKER','INTERNAL')),
        correlation_id         text        NOT NULL,
        message_id             text,
        instance_id            text        NOT NULL,
        details                jsonb       NOT NULL DEFAULT '{}'::jsonb,
        occurred_at            timestamptz NOT NULL,
        CONSTRAINT ck_audit_rejected_has_code
          CHECK (action <> 'REJECTED' OR failure_code IS NOT NULL)
      );
    `);
    this.addSql(
      'CREATE INDEX ix_audit_tx_time ON wager_transaction_audit (transaction_id, occurred_at, id);',
    );
    this.addSql(
      'CREATE INDEX ix_audit_wallet_time ON wager_transaction_audit (wallet_id, occurred_at);',
    );
    this.addSql(`
      CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON wager_transaction_audit
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON wager_transaction_audit
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);
    // cada lançamento do ledger tem no máximo uma auditoria PROCESSED (rastreio do dinheiro, IT-25)
    this.addSql(`
      CREATE UNIQUE INDEX uq_audit_ledger_entry ON wager_transaction_audit (ledger_entry_id)
        WHERE ledger_entry_id IS NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE wager_transaction_audit;');
  }
}
