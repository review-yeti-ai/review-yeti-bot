import { MAX_COMPLETION_BYTES } from '../review/workerReviewCompletion';
import { MAX_REVIEW_CHECKPOINT_BYTES } from '../review/reviewExecutionCheckpoint';

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
  -- The verified worker completion for each accepted execution attempt. Until
  -- this table existed the service kept only the payload's digest and its
  -- P0/P1 counts, so "what did the worker actually find" survived nowhere but
  -- the published check text. content_digest is the same value stored as
  -- review_gate_attempts.worker_result_digest, binding the row to its gate
  -- record. Written inside the completion transaction; never updated.
  CREATE TABLE IF NOT EXISTS review_worker_completions (
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    content_digest VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, execution_attempt)
  );
  -- The byte bound is the wire contract's (MAX_COMPLETION_BYTES). CREATE TABLE
  -- IF NOT EXISTS never rewrites an existing table, so a bound baked into the
  -- CREATE would be frozen at first install and drift from the parser the day
  -- the contract changes. Re-applying a named constraint on every initialize
  -- keeps the deployed CHECK equal to the running code's constant.
  ALTER TABLE review_worker_completions
    DROP CONSTRAINT IF EXISTS review_worker_completions_byte_length_check;
  ALTER TABLE review_worker_completions
    ADD CONSTRAINT review_worker_completions_byte_length_check
    CHECK (byte_length > 0 AND byte_length <= ${MAX_COMPLETION_BYTES});
  CREATE INDEX IF NOT EXISTS review_worker_completions_created_at_idx
    ON review_worker_completions (created_at);
  -- Mutable, monotonic exact-head progress for one logical review run. Unlike
  -- terminal completions this row may advance while a worker is alive; a
  -- strictly increasing revision prevents a slower concurrent task callback
  -- from replacing a newer snapshot. It survives worker Jobs and attempts so
  -- an exact-head retry can resume completed review tasks.
  CREATE TABLE IF NOT EXISTS review_execution_checkpoints (
    run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    head_sha VARCHAR(40) NOT NULL,
    config_digest VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    byte_length INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE review_execution_checkpoints
    DROP CONSTRAINT IF EXISTS review_execution_checkpoints_byte_length_check;
  ALTER TABLE review_execution_checkpoints
    ADD CONSTRAINT review_execution_checkpoints_byte_length_check
    CHECK (byte_length > 0 AND byte_length <= ${MAX_REVIEW_CHECKPOINT_BYTES});
  CREATE INDEX IF NOT EXISTS review_execution_checkpoints_updated_at_idx
    ON review_execution_checkpoints (updated_at);
  -- A dispute is a request for a fresh provider review, never a mutation of
  -- an immutable completion or its published Gate. Requests are bounded per
  -- logical run and bound to their source completion, task plan, and Gate.
  CREATE TABLE IF NOT EXISTS review_finding_rechecks (
    request_id UUID PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    source_execution_attempt INTEGER NOT NULL CHECK (source_execution_attempt > 0),
    source_content_digest VARCHAR(64) NOT NULL CHECK (source_content_digest ~ '^[a-f0-9]{64}$'),
    source_plan_digest VARCHAR(64) NOT NULL CHECK (source_plan_digest ~ '^[a-f0-9]{64}$'),
    source_gate_attempt_id TEXT NOT NULL REFERENCES review_gate_attempts(attempt_id),
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    head_sha VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
    base_sha VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
    policy_digest VARCHAR(64) NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
    config_digest VARCHAR(64) NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
    finding_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    finding JSONB NOT NULL,
    counter_argument TEXT NOT NULL CHECK (length(counter_argument) BETWEEN 1 AND 10000),
    counter_argument_digest VARCHAR(64) NOT NULL CHECK (counter_argument_digest ~ '^[a-f0-9]{64}$'),
    request_digest VARCHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
    requested_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (run_id, source_execution_attempt, task_id)
  );
  CREATE INDEX IF NOT EXISTS review_finding_rechecks_run_created_idx
    ON review_finding_rechecks (run_id, created_at DESC);
  -- Append-only authorization for the fresh execution started by a completed
  -- review's authenticated task request. General retry admission is unchanged.
  CREATE TABLE IF NOT EXISTS review_finding_recheck_admissions (
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    source_execution_attempt INTEGER NOT NULL CHECK (source_execution_attempt > 0),
    trigger_request_id UUID NOT NULL UNIQUE REFERENCES review_finding_rechecks(request_id),
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt = source_execution_attempt + 1),
    review_generation INTEGER NOT NULL CHECK (review_generation > 0),
    gate_attempt_id TEXT NOT NULL UNIQUE REFERENCES review_gate_attempts(attempt_id),
    requested_by VARCHAR(64) NOT NULL CHECK (requested_by ~ '^[a-f0-9]{64}$'),
    received_at TIMESTAMPTZ NOT NULL,
    terminal_deadline TIMESTAMPTZ NOT NULL CHECK (terminal_deadline > received_at),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (run_id, source_execution_attempt)
  );
`;
