import { MAX_COMPLETION_BYTES } from '../review/workerReviewCompletion';

/** Additive schema for the service-owned check publication outbox. No consumer
 * protection or CI admission is activated by installing these tables. */
export const REVIEW_GATE_SCHEMA_SQL = `
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS authoritative_gate_app_id BIGINT
    CHECK (authoritative_gate_app_id > 0);
  -- One-time compatibility bridge for legacy App-gate successes created
  -- before action-dispatch persisted the receipt choice explicitly. This runs
  -- after authoritative_gate_app_id and terminal_receipt_digest both exist.
  -- Some independently installed gate-store consumers do not own the dispatch
  -- table, while narrow legacy schemas can omit the run result columns. Keep
  -- this additive schema usable in both cases and backfill only the full
  -- action-dispatch shape. Runtime readers consume only the persisted receipt;
  -- they do not re-derive this historical success predicate.
  DO $$
  BEGIN
    IF to_regclass('review_dispatch_outbox') IS NOT NULL THEN
      ALTER TABLE review_dispatch_outbox
        ADD COLUMN IF NOT EXISTS terminal_receipt_digest VARCHAR(64)
          CHECK (terminal_receipt_digest IS NULL OR terminal_receipt_digest ~ '^[a-f0-9]{64}$');

      IF EXISTS (
        SELECT 1
          FROM pg_attribute
         WHERE attrelid = to_regclass('review_runs')
           AND attname = 'publication_mode'
           AND NOT attisdropped
      ) AND EXISTS (
        SELECT 1
          FROM pg_attribute
         WHERE attrelid = to_regclass('review_runs')
           AND attname = 'result_digest'
           AND NOT attisdropped
      ) THEN
        EXECUTE $backfill$
          UPDATE review_dispatch_outbox AS outbox
             SET terminal_receipt_digest = runs.result_digest
            FROM review_runs AS runs
           WHERE outbox.run_id = runs.run_id
             AND outbox.terminal_receipt_digest IS NULL
             AND outbox.status = 'terminal'
             AND runs.status = 'succeeded'
             AND runs.publication_mode = 'app-gate'
             AND runs.authoritative_gate_app_id IS NULL
             AND runs.result_digest ~ '^[a-f0-9]{64}$'
        $backfill$;
      END IF;
    END IF;
  END $$;
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
`;
