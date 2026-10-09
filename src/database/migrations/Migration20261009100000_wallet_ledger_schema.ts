import { Migration } from '@mikro-orm/migrations';

/**
 * Iteração 2 — schema financeiro com as garantias no banco (restrição 9, docs/03 §7):
 * unicidade, imutabilidade, não-negatividade, aritmética e cadeia do ledger, e a
 * consistência saldo materializado × ledger verificada no commit.
 *
 * FKs são DEFERRABLE INITIALLY DEFERRED: dentro de uma transação a ordem dos INSERTs
 * não importa (Unit of Work), mas a integridade é verificada no COMMIT.
 */
export class Migration20261009100000_wallet_ledger_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
        version     integer       NOT NULL CHECK (version >= 1),
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT uq_wallet_player_currency UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL CHECK (provider_id <> ''),
        external_transaction_id           text          NOT NULL CHECK (external_transaction_id <> ''),
        idempotency_key                   text          NOT NULL CHECK (idempotency_key <> ''),
        payload_hash                      char(64)      NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid          NOT NULL
                                          REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        player_id                         uuid          NOT NULL,
        round_id                          text,
        game_id                           text,
        kind                              text          NOT NULL
                                          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid
                                          REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        related_transaction_id            uuid
                                          REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        status                            text          NOT NULL
                                          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        balance_after                     numeric(20,2) CHECK (balance_after >= 0),
        attempts                          integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at                   timestamptz,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT uq_tx_idempotency_key   UNIQUE (idempotency_key),
        CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT ck_tx_reference_required
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT ck_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT ck_tx_round_required
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
        CONSTRAINT ck_tx_amount_positive CHECK (kind = 'LOSS' OR amount > 0),
        CONSTRAINT ck_tx_failure_code
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT ck_tx_decided_snapshot
          CHECK (status NOT IN ('PROCESSED','REJECTED') OR (balance_after IS NOT NULL AND processed_at IS NOT NULL)),
        CONSTRAINT ck_tx_pending_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      );
    `);
    // reversão única por referência, de qualquer tipo (D-01 / ADR-08)
    this.addSql(`
      CREATE UNIQUE INDEX uq_tx_single_reversal ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_pending_reference ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX ix_tx_reference_lookup
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE reference_external_transaction_id IS NOT NULL;
    `);
    this.addSql(`
      CREATE INDEX ix_tx_player_time ON wager_transactions (player_id, created_at)
        WHERE kind IN ('BET','REFUND','ROLLBACK');
    `);
    this.addSql('CREATE INDEX ix_tx_wallet ON wager_transactions (wallet_id);');

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL REFERENCES wallets(id) DEFERRABLE INITIALLY DEFERRED,
        wallet_version  integer       NOT NULL CHECK (wallet_version >= 1),
        transaction_id  uuid          NOT NULL
                                      REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED,
        direction       text          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CHECK (amount > 0),
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz   NOT NULL,
        CONSTRAINT uq_ledger_tx_wallet      UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    // imutabilidade estrutural: UPDATE, DELETE e TRUNCATE recusados
    this.addSql(`
      CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
    `);

    // cadeia: cada lançamento começa onde o anterior terminou, na mesma moeda da wallet
    this.addSql(`
      CREATE FUNCTION check_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        previous_after numeric(20,2);
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS NOT NULL AND wallet_currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'check_violation';
        END IF;

        SELECT balance_after INTO previous_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF COALESCE(previous_after, 0) <> NEW.balance_before THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            NEW.wallet_id, NEW.balance_before, COALESCE(previous_after, 0)
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION check_ledger_chain();
    `);

    // saldo materializado = último lançamento, verificado no COMMIT
    this.addSql(`
      CREATE FUNCTION check_wallet_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        last_version integer;
        last_after   numeric(20,2);
      BEGIN
        SELECT wallet_version, balance_after INTO last_version, last_after
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF last_version IS NULL THEN
          IF NEW.balance <> 0 OR NEW.version <> 1 THEN
            RAISE EXCEPTION 'wallet % has balance % (version %) without ledger entries',
              NEW.id, NEW.balance, NEW.version USING ERRCODE = 'check_violation';
          END IF;
        ELSIF last_version <> NEW.version OR last_after <> NEW.balance THEN
          RAISE EXCEPTION 'wallet % (balance %, version %) does not match ledger (balance %, version %)',
            NEW.id, NEW.balance, NEW.version, last_after, last_version USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END
      $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER trg_wallet_matches_ledger
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_wallet_matches_ledger();
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    uuid        NOT NULL,
        event_type      text        NOT NULL CHECK (event_type <> ''),
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        locked_until    timestamptz,
        locked_by       text,
        published_at    timestamptz
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE outbox_messages;');
    this.addSql('DROP TABLE wallet_ledger_entries;');
    this.addSql('DROP FUNCTION check_ledger_chain();');
    this.addSql('DROP TABLE wager_transactions;');
    this.addSql('DROP TABLE wallets;');
    this.addSql('DROP FUNCTION check_wallet_matches_ledger();');
  }
}
