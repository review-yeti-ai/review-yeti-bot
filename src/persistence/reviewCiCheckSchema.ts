/** Additive, default-off persistence for the service-owned `Review Yeti CI`
 * check. This schema does not admit CI, alter protection, or contact GitHub. */
export const REVIEW_CI_CHECK_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_ci_check_attempts (
    request_id UUID PRIMARY KEY REFERENCES review_ci_requests(request_id) ON DELETE CASCADE,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    pr_number BIGINT NOT NULL CHECK (pr_number > 0),
    expected_app_id BIGINT NOT NULL CHECK (expected_app_id > 0),
    review JSONB NOT NULL,
    candidate_sha VARCHAR(40) NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
    workflow_sha VARCHAR(40) NOT NULL CHECK (workflow_sha ~ '^[a-f0-9]{40}$'),
    lane_plan_digest VARCHAR(64) NOT NULL CHECK (lane_plan_digest ~ '^[a-f0-9]{64}$'),
    immutable_binding_digest VARCHAR(64) NOT NULL CHECK (immutable_binding_digest ~ '^[a-f0-9]{64}$'),
    external_id TEXT NOT NULL UNIQUE,
    current_epoch INTEGER NOT NULL CHECK (current_epoch > 0),
    claimed_execution JSONB,
    claimed_run_id BIGINT UNIQUE CHECK (claimed_run_id > 0),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('queued','in_progress','success','failure','cancelled','timed_out')),
    desired_version BIGINT NOT NULL CHECK (desired_version > 0),
    published_version BIGINT NOT NULL DEFAULT -1 CHECK (published_version <= desired_version),
    check_id BIGINT UNIQUE CHECK (check_id > 0),
    creation_state TEXT NOT NULL DEFAULT 'reserved' CHECK (creation_state IN ('reserved','creating','bound')),
    terminal_receipt JSONB,
    terminal_digest VARCHAR(64) CHECK (terminal_digest ~ '^[a-f0-9]{64}$'),
    last_error_class TEXT CHECK (last_error_class IN ('transport','unknown-create','identity-conflict','stale-claim')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((creation_state = 'bound') = (check_id IS NOT NULL)),
    CHECK ((claimed_execution IS NULL) = (claimed_run_id IS NULL)),
    CHECK ((terminal_receipt IS NULL) = (terminal_digest IS NULL)),
    CHECK (desired_state <> 'success' OR terminal_receipt IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS review_ci_check_outbox (
    request_id UUID PRIMARY KEY REFERENCES review_ci_check_attempts(request_id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','published')),
    lease_owner TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error_class TEXT CHECK (last_error_class IN ('transport','unknown-create','identity-conflict','stale-claim')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((lease_owner IS NULL) = (lease_token IS NULL)),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
  );
  CREATE INDEX IF NOT EXISTS review_ci_check_due_idx
    ON review_ci_check_outbox(available_at, lease_expires_at)
    WHERE state IN ('pending','claimed');
  CREATE OR REPLACE FUNCTION review_ci_check_guard_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF ROW(NEW.request_id,NEW.repository_id,NEW.pr_number,NEW.expected_app_id,NEW.review,
      NEW.candidate_sha,NEW.workflow_sha,NEW.lane_plan_digest,NEW.immutable_binding_digest,NEW.external_id)
      IS DISTINCT FROM ROW(OLD.request_id,OLD.repository_id,OLD.pr_number,OLD.expected_app_id,OLD.review,
      OLD.candidate_sha,OLD.workflow_sha,OLD.lane_plan_digest,OLD.immutable_binding_digest,OLD.external_id)
      OR (OLD.terminal_receipt IS NOT NULL AND ROW(NEW.terminal_receipt,NEW.terminal_digest)
        IS DISTINCT FROM ROW(OLD.terminal_receipt,OLD.terminal_digest))
      OR (OLD.claimed_execution IS NOT NULL AND ROW(NEW.claimed_execution,NEW.claimed_run_id)
        IS DISTINCT FROM ROW(OLD.claimed_execution,OLD.claimed_run_id))
    THEN RAISE EXCEPTION 'Review CI check identity is immutable'; END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS review_ci_check_immutable_identity ON review_ci_check_attempts;
  CREATE TRIGGER review_ci_check_immutable_identity BEFORE UPDATE ON review_ci_check_attempts
    FOR EACH ROW EXECUTE FUNCTION review_ci_check_guard_identity();
`;
