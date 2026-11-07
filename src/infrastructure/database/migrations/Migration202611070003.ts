import { Migration } from '@mikro-orm/migrations';

export class Migration202611070003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_id_currency UNIQUE(id,currency);
      CREATE TABLE journal_postings (
        id uuid PRIMARY KEY, ledger_id uuid NOT NULL, account text NOT NULL,
        side text NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK(amount > 0), currency text NOT NULL,
        UNIQUE(ledger_id,side), UNIQUE(ledger_id,account),
        FOREIGN KEY(ledger_id,currency) REFERENCES wallet_ledger(id,currency) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX journal_account_history ON journal_postings(account,ledger_id);
      -- Historical movements receive matching immutable postings; existing ledger rows remain untouched.
      INSERT INTO journal_postings SELECT gen_random_uuid(),id,'wallet:' || wallet_id,direction,amount,currency FROM wallet_ledger;
      INSERT INTO journal_postings SELECT gen_random_uuid(),id,'clearing:' || currency,
        CASE direction WHEN 'CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END,amount,currency FROM wallet_ledger;
      CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON journal_postings FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER no_truncate_journal BEFORE TRUNCATE ON journal_postings FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
      CREATE FUNCTION verify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target uuid; movement wallet_ledger; total integer; matched integer; net numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wallet_ledger' THEN target := NEW.id; ELSE target := NEW.ledger_id; END IF;
        SELECT * INTO movement FROM wallet_ledger WHERE id = target;
        SELECT count(*), COALESCE(sum(CASE side WHEN 'DEBIT' THEN amount ELSE -amount END),0),
          count(*) FILTER(WHERE amount = movement.amount AND currency = movement.currency AND
            ((account = 'wallet:' || movement.wallet_id AND side = movement.direction) OR
             (account = 'clearing:' || movement.currency AND side <> movement.direction)))
          INTO total,net,matched FROM journal_postings WHERE ledger_id = target;
        IF total <> 2 OR net <> 0 OR matched <> 2 THEN
          RAISE EXCEPTION 'journal must balance and match its wallet movement' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER ledger_requires_journal AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_journal();
      CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON journal_postings
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_journal();
      ALTER TABLE outbox ADD COLUMN trace_context jsonb NOT NULL DEFAULT '{}';
      CREATE FUNCTION protect_trace_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.trace_context IS DISTINCT FROM OLD.trace_context THEN
          RAISE EXCEPTION 'event trace context is immutable' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_trace_context BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION protect_trace_context();
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER protect_trace_context ON outbox; DROP FUNCTION protect_trace_context();
      ALTER TABLE outbox DROP COLUMN trace_context;
      DROP TRIGGER ledger_requires_journal ON wallet_ledger;
      DROP TABLE journal_postings; DROP FUNCTION verify_journal();
      ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_id_currency;
    `);
  }
}
