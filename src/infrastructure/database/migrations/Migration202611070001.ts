import { Migration } from '@mikro-orm/migrations';

export class Migration202611070001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) NOT NULL CHECK (balance >= 0), version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency), UNIQUE (id, currency)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL,
        wallet_id uuid NOT NULL, player_id uuid NOT NULL, round_id text NOT NULL, game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text, reference_transaction_id uuid REFERENCES wager_transactions(id),
        failure_code text, result_balance numeric(20,2) CHECK (result_balance >= 0),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), next_attempt_at timestamptz,
        correlation_id text NOT NULL, created_at timestamptz NOT NULL, processed_at timestamptz,
        UNIQUE(provider_id, external_transaction_id), UNIQUE(id, wallet_id, currency),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX one_reversal_per_kind ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX pending_reference_due ON wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE wallet_ledger (
        id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0), currency text NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1), created_at timestamptz NOT NULL,
        UNIQUE (wallet_id, transaction_id), UNIQUE (wallet_id, wallet_version),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency) DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency) DEFERRABLE INITIALLY DEFERRED,
        CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_pagination ON wallet_ledger(wallet_id, wallet_version);
      CREATE TABLE inbox (
        id uuid PRIMARY KEY, consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id) DEFERRABLE INITIALLY DEFERRED, received_at timestamptz NOT NULL,
        processed_at timestamptz NOT NULL, UNIQUE (consumer_name, message_id)
      );
      CREATE TABLE outbox (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL, published_at timestamptz, lease_owner text, lease_until timestamptz,
        CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
      );
      CREATE INDEX outbox_due ON outbox(next_attempt_at, occurred_at, id) WHERE published_at IS NULL;

      CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
      END $$;
      CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON wallet_ledger
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
      CREATE TRIGGER immutable_inbox BEFORE UPDATE OR DELETE ON inbox
        FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

      CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transactions cannot be deleted' USING ERRCODE = '23514'; END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'terminal transaction is immutable' USING ERRCODE = '23514';
        END IF;
        IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
          NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
          NEW.reference_external_transaction_id, NEW.created_at, NEW.correlation_id)
          IS DISTINCT FROM ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
          OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount,
          OLD.currency, OLD.reference_external_transaction_id, OLD.created_at, OLD.correlation_id) THEN
          RAISE EXCEPTION 'transaction business payload is immutable' USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid state transition' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_transaction BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION protect_transaction();

      CREATE FUNCTION protect_wallet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'wallet cannot be deleted' USING ERRCODE = '23514'; END IF;
        IF ROW(NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM
          ROW(OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF (NEW.balance IS DISTINCT FROM OLD.balance AND NEW.version <> OLD.version + 1) OR
          (NEW.balance IS NOT DISTINCT FROM OLD.balance AND NEW.version <> OLD.version) THEN
          RAISE EXCEPTION 'invalid wallet version' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_wallet BEFORE UPDATE OR DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION protect_wallet();

      -- Deferred checks see the complete financial unit of work, regardless of ORM insert order.
      CREATE FUNCTION verify_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target uuid; stored numeric; calculated numeric; current_version integer; latest_version integer;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN target := NEW.id; ELSE target := NEW.wallet_id; END IF;
        SELECT balance, version INTO stored, current_version FROM wallets WHERE id = target;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0),
          COALESCE(MAX(wallet_version),1) INTO calculated, latest_version FROM wallet_ledger WHERE wallet_id = target;
        IF stored IS DISTINCT FROM calculated OR current_version <> latest_version THEN
          RAISE EXCEPTION 'wallet and ledger diverged' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_ledger_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_wallet_ledger();

      CREATE FUNCTION verify_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE t wager_transactions; entry wallet_ledger; total integer; prior_balance numeric;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN SELECT * INTO t FROM wager_transactions WHERE id = NEW.id;
        ELSE SELECT * INTO t FROM wager_transactions WHERE id = NEW.transaction_id; END IF;
        SELECT COUNT(*) INTO total FROM wallet_ledger WHERE transaction_id = t.id;
        IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
          IF total <> 1 THEN RAISE EXCEPTION 'processed transaction requires one ledger entry' USING ERRCODE = '23514'; END IF;
          SELECT * INTO entry FROM wallet_ledger WHERE transaction_id = t.id;
          IF entry.amount <> t.amount OR entry.currency <> t.currency OR entry.balance_after <> t.result_balance THEN
            RAISE EXCEPTION 'transaction ledger mismatch' USING ERRCODE = '23514';
          END IF;
          SELECT balance_after INTO prior_balance FROM wallet_ledger
            WHERE wallet_id = entry.wallet_id AND wallet_version < entry.wallet_version ORDER BY wallet_version DESC LIMIT 1;
          IF entry.balance_before <> COALESCE(prior_balance,0) THEN
            RAISE EXCEPTION 'broken ledger balance chain' USING ERRCODE = '23514';
          END IF;
          IF (t.kind = 'BET' AND entry.direction <> 'DEBIT') OR
            (t.kind IN ('OPENING','WIN','REFUND') AND entry.direction <> 'CREDIT') THEN
            RAISE EXCEPTION 'incorrect ledger direction' USING ERRCODE = '23514';
          END IF;
        ELSIF total <> 0 THEN RAISE EXCEPTION 'non-financial transaction cannot have ledger' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistency AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_transaction_ledger();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox, inbox, wallet_ledger, wager_transactions, wallets CASCADE;
      DROP FUNCTION IF EXISTS verify_transaction_ledger(), verify_wallet_ledger(), protect_wallet(), protect_transaction(), forbid_mutation();`);
  }
}
