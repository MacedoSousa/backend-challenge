import { Migration } from '@mikro-orm/migrations';

/**
 * Função compartilhada pelas tabelas append-only (ledger, auditoria).
 * Os triggers que a usam são criados junto com cada tabela (Iteração 2).
 */
export class Migration20261009000000_bootstrap extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE FUNCTION forbid_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END
      $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP FUNCTION forbid_mutation();');
  }
}
