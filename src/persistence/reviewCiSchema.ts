/** Additive persistence only. Installation does not enable delivery or admission. */
export const REVIEW_CI_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_ci_requests (
    request_id UUID PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    pr_number BIGINT NOT NULL CHECK (pr_number > 0),
    expected_app_id BIGINT NOT NULL CHECK (expected_app_id > 0),
    review JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','admitted','running','completed','superseded','delivery_error')),
    binding JSONB,
    identity_digest VARCHAR(64) UNIQUE CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
    workflow_epoch INTEGER NOT NULL DEFAULT 0 CHECK (workflow_epoch >= 0),
    execution JSONB,
    execution_run_id BIGINT UNIQUE CHECK (execution_run_id > 0),
    terminal_receipt JSONB,
    terminal_digest VARCHAR(64) CHECK (terminal_digest ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((binding IS NULL) = (identity_digest IS NULL)),
    CHECK ((execution IS NULL) = (execution_run_id IS NULL)),
    CHECK ((terminal_receipt IS NULL) = (terminal_digest IS NULL)),
    CHECK (state NOT IN ('admitted','running','completed') OR binding IS NOT NULL),
    CHECK (state NOT IN ('running','completed') OR execution IS NOT NULL),
    CHECK (state <> 'completed' OR terminal_receipt IS NOT NULL)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS review_ci_active_pr_idx ON review_ci_requests(repository_id, pr_number)
    WHERE state IN ('admitted','running');
  CREATE TABLE IF NOT EXISTS review_ci_deliveries (
    request_id UUID NOT NULL REFERENCES review_ci_requests(request_id),
    kind TEXT NOT NULL CHECK (kind IN ('repository','workflow')),
    epoch INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending','dispatching','uncertain','dispatched','claimed','completed','fenced','terminal_error')),
    dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
    lease_owner TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatch_started_at TIMESTAMPTZ,
    reconciliation JSONB,
    acknowledged_run JSONB,
    last_error_class TEXT CHECK (last_error_class IN ('transport','timeout','delivery-exhausted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (request_id, kind, epoch),
    CHECK ((kind = 'repository' AND epoch = 0) OR (kind = 'workflow' AND epoch > 0)),
    CHECK ((lease_owner IS NULL) = (lease_token IS NULL)),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
  );
  CREATE INDEX IF NOT EXISTS review_ci_delivery_due_idx ON review_ci_deliveries(available_at, lease_expires_at)
    WHERE state IN ('pending','dispatching','uncertain','dispatched');
  CREATE OR REPLACE FUNCTION review_ci_guard_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF ROW(NEW.request_id,NEW.attempt_id,NEW.repository_id,NEW.pr_number,NEW.expected_app_id,NEW.review)
      IS DISTINCT FROM ROW(OLD.request_id,OLD.attempt_id,OLD.repository_id,OLD.pr_number,OLD.expected_app_id,OLD.review)
      OR (OLD.binding IS NOT NULL AND ROW(NEW.binding,NEW.identity_digest) IS DISTINCT FROM ROW(OLD.binding,OLD.identity_digest))
      OR (OLD.execution IS NOT NULL AND ROW(NEW.execution,NEW.execution_run_id) IS DISTINCT FROM ROW(OLD.execution,OLD.execution_run_id))
      OR (OLD.terminal_receipt IS NOT NULL AND ROW(NEW.terminal_receipt,NEW.terminal_digest) IS DISTINCT FROM ROW(OLD.terminal_receipt,OLD.terminal_digest))
    THEN RAISE EXCEPTION 'Review CI identity is immutable'; END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS review_ci_immutable_identity ON review_ci_requests;
  CREATE TRIGGER review_ci_immutable_identity BEFORE UPDATE ON review_ci_requests
    FOR EACH ROW EXECUTE FUNCTION review_ci_guard_identity();
`;
