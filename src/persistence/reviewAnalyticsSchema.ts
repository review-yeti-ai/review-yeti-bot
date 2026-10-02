/**
 * PostgreSQL DDL Schema for Review Yeti Executive & Engineering Analytics Dashboard.
 */

export const REVIEW_ANALYTICS_SCHEMA_SQL = `
  -- 1. Operational Review Runs Telemetry & Query Indices
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
  ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC(10, 4);

  CREATE INDEX IF NOT EXISTS review_runs_analytics_created_at_idx
    ON review_runs (created_at DESC);
  CREATE INDEX IF NOT EXISTS review_runs_analytics_repo_created_at_idx
    ON review_runs (repo, created_at DESC);
  CREATE INDEX IF NOT EXISTS review_runs_analytics_owner_repo_idx
    ON review_runs (owner, repo, created_at DESC);
  CREATE INDEX IF NOT EXISTS review_runs_analytics_status_created_at_idx
    ON review_runs (status, created_at DESC);

  -- 2. Review Logs Query Acceleration
  ALTER TABLE review_logs ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
  ALTER TABLE review_logs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 4);
  ALTER TABLE review_logs ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER;
  ALTER TABLE review_logs ADD COLUMN IF NOT EXISTS completion_tokens INTEGER;
  ALTER TABLE review_logs ADD COLUMN IF NOT EXISTS total_tokens INTEGER;

  CREATE INDEX IF NOT EXISTS review_logs_timestamp_idx
    ON review_logs (timestamp DESC);
  CREATE INDEX IF NOT EXISTS review_logs_repo_timestamp_idx
    ON review_logs (repo, timestamp DESC);

  -- 3. Dedicated Historical Analytics Snapshots Table
  CREATE TABLE IF NOT EXISTS review_analytics_snapshots (
    id VARCHAR(255) PRIMARY KEY,
    run_id VARCHAR(255),
    repo VARCHAR(255) NOT NULL,
    pr_number INT NOT NULL,
    head_sha VARCHAR(255),
    verdict VARCHAR(32) NOT NULL DEFAULT 'SHIP',
    status VARCHAR(32) NOT NULL DEFAULT 'completed',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0.0000,
    p0_count INTEGER NOT NULL DEFAULT 0,
    p1_count INTEGER NOT NULL DEFAULT 0,
    p2_count INTEGER NOT NULL DEFAULT 0,
    dismissed_count INTEGER NOT NULL DEFAULT 0,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS review_analytics_snapshots_created_at_idx
    ON review_analytics_snapshots (created_at DESC);
  CREATE INDEX IF NOT EXISTS review_analytics_snapshots_repo_created_at_idx
    ON review_analytics_snapshots (repo, created_at DESC);
`;
