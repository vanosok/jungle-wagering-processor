import { Migration } from '@mikro-orm/migrations';

export class Migration202611070002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE outbox ADD COLUMN enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp();
      CREATE TRIGGER no_truncate_ledger BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER no_truncate_inbox BEFORE TRUNCATE ON inbox FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER no_truncate_transactions BEFORE TRUNCATE ON wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER no_truncate_wallets BEFORE TRUNCATE ON wallets FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER no_truncate_outbox BEFORE TRUNCATE ON outbox FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

      CREATE FUNCTION protect_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'outbox deletion is disabled' USING ERRCODE = '23514'; END IF;
        IF ROW(NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at, NEW.enqueued_at)
          IS DISTINCT FROM ROW(OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at, OLD.enqueued_at) THEN
          RAISE EXCEPTION 'outbox event is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'published event cannot become pending again' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_outbox BEFORE UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION protect_outbox();

      CREATE FUNCTION verify_processed_reference() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; ref wager_transactions; owner_id uuid; wallet_currency text; actual text; expected text;
      BEGIN
        SELECT * INTO t FROM wager_transactions WHERE id = NEW.id;
        IF t.status <> 'PROCESSED' THEN RETURN NULL; END IF;
        SELECT player_id, currency INTO owner_id, wallet_currency FROM wallets WHERE id = t.wallet_id;
        IF owner_id IS NULL OR owner_id <> t.player_id OR wallet_currency <> t.currency THEN
          RAISE EXCEPTION 'processed transaction has invalid wallet context' USING ERRCODE = '23514';
        END IF;
        IF t.kind IN ('REFUND','ROLLBACK') AND t.reference_transaction_id IS NULL THEN
          RAISE EXCEPTION 'processed reversal requires reference' USING ERRCODE = '23514';
        END IF;
        IF t.reference_transaction_id IS NOT NULL THEN
          SELECT * INTO ref FROM wager_transactions WHERE id = t.reference_transaction_id;
          IF ref.id IS NULL OR ref.status <> 'PROCESSED' OR
            ROW(ref.provider_id,ref.player_id,ref.wallet_id,ref.currency,ref.round_id,ref.external_transaction_id)
            IS DISTINCT FROM ROW(t.provider_id,t.player_id,t.wallet_id,t.currency,t.round_id,t.reference_external_transaction_id) THEN
            RAISE EXCEPTION 'reference context mismatch' USING ERRCODE = '23514';
          END IF;
          IF (t.kind IN ('REFUND','WIN') AND ref.kind <> 'BET') OR
            (t.kind = 'ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND')) OR
            (t.kind NOT IN ('REFUND','ROLLBACK','WIN')) THEN
            RAISE EXCEPTION 'invalid reference kind' USING ERRCODE = '23514';
          END IF;
          IF t.kind IN ('REFUND','ROLLBACK') AND t.amount <> ref.amount THEN
            RAISE EXCEPTION 'partial reversal is forbidden' USING ERRCODE = '23514';
          END IF;
          IF t.kind = 'ROLLBACK' THEN
            SELECT CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END INTO expected
              FROM wallet_ledger WHERE transaction_id = ref.id;
            SELECT direction INTO actual FROM wallet_ledger WHERE transaction_id = t.id;
            IF actual IS DISTINCT FROM expected THEN
              RAISE EXCEPTION 'rollback direction mismatch' USING ERRCODE = '23514';
            END IF;
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER processed_reference_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_processed_reference();
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS processed_reference_consistency ON wager_transactions;
      DROP FUNCTION IF EXISTS verify_processed_reference();
      DROP TRIGGER IF EXISTS protect_outbox ON outbox;
      DROP FUNCTION IF EXISTS protect_outbox();
      DROP TRIGGER IF EXISTS no_truncate_ledger ON wallet_ledger;
      DROP TRIGGER IF EXISTS no_truncate_inbox ON inbox;
      DROP TRIGGER IF EXISTS no_truncate_transactions ON wager_transactions;
      DROP TRIGGER IF EXISTS no_truncate_wallets ON wallets;
      DROP TRIGGER IF EXISTS no_truncate_outbox ON outbox;
      ALTER TABLE outbox DROP COLUMN enqueued_at;
    `);
  }
}
