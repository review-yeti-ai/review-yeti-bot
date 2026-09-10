/** Additive schema for the service-owned check publication outbox. No consumer
 * protection or CI admission is activated by installing these tables. */
export const REVIEW_GATE_SCHEMA_SQL = `
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS authoritative_gate_app_id BIGINT
    CHECK (authoritative_gate_app_id > 0);
  CREATE TABLE IF NOT EXISTS review_gate_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    review_generation INTEGER NOT NULL CHECK (review_generation >= 0),
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    repository_id BIGINT NOT NULL,
    pr_number INTEGER NOT NULL,
    expected_app_id BIGINT NOT NULL CHECK (expected_app_id > 0),
    coordinates JSONB NOT NULL,
    external_id TEXT NOT NULL UNIQUE,
    check_id BIGINT UNIQUE CHECK (check_id > 0),
    creation_state TEXT NOT NULL DEFAULT 'reserved'
      CHECK (creation_state IN ('reserved', 'creating', 'bound')),
    desired_state TEXT NOT NULL DEFAULT 'queued'
      CHECK (desired_state IN ('queued', 'in_progress', 'success', 'failure', 'cancelled', 'timed_out')),
    desired_version BIGINT NOT NULL DEFAULT 0,
    published_version BIGINT NOT NULL DEFAULT -1,
    current_attempt BOOLEAN NOT NULL DEFAULT true,
    evidence JSONB,
    decision JSONB,
    worker_result_digest VARCHAR(64),
    lease_owner TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error_class TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (run_id, review_generation),
    CHECK ((creation_state = 'bound') = (check_id IS NOT NULL))
  );
  ALTER TABLE review_gate_attempts ADD COLUMN IF NOT EXISTS lease_token UUID;
  ALTER TABLE review_gate_attempts ADD COLUMN IF NOT EXISTS worker_result_digest VARCHAR(64);
  CREATE UNIQUE INDEX IF NOT EXISTS review_gate_current_candidate_idx
    ON review_gate_attempts (repository_id, pr_number) WHERE current_attempt;
  CREATE INDEX IF NOT EXISTS review_gate_publication_idx
    ON review_gate_attempts (available_at, lease_expires_at)
    WHERE published_version < desired_version;
`;
