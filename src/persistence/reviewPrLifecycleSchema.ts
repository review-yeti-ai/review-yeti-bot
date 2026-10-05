/**
 * Durable semantic review history. All tables are additive so an upgrade can
 * initialize against databases that only have the legacy run/event ledgers.
 * Identity and source evidence are retained per exact run attempt; findings
 * and lifecycle events are append-only.
 */
export const REVIEW_PR_LIFECYCLE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_pr_lifecycles (
    lifecycle_id UUID PRIMARY KEY,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repository_id, pr_number)
  );

  CREATE TABLE IF NOT EXISTS review_pr_review_reservations (
    reservation_id UUID PRIMARY KEY,
    lifecycle_id UUID NOT NULL REFERENCES review_pr_lifecycles(lifecycle_id),
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    delivery_id TEXT NOT NULL,
    head_sha VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
    base_sha VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
    policy_digest VARCHAR(64) NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
    config_digest VARCHAR(64) NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
    context_digest VARCHAR(64) NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'reserved'
      CHECK (status IN ('reserved', 'completed', 'failed', 'cancelled', 'superseded')),
    completion_digest VARCHAR(64) CHECK (completion_digest IS NULL OR completion_digest ~ '^[a-f0-9]{64}$'),
    decision_receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    UNIQUE (run_id, execution_attempt)
  );
  CREATE INDEX IF NOT EXISTS review_pr_reservations_lifecycle_idx
    ON review_pr_review_reservations (lifecycle_id, created_at, execution_attempt);

  CREATE TABLE IF NOT EXISTS review_pr_lifecycle_events (
    event_id UUID PRIMARY KEY,
    lifecycle_id UUID NOT NULL REFERENCES review_pr_lifecycles(lifecycle_id),
    reservation_id UUID REFERENCES review_pr_review_reservations(reservation_id),
    idempotency_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    run_id TEXT,
    execution_attempt INTEGER CHECK (execution_attempt IS NULL OR execution_attempt > 0),
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    head_sha VARCHAR(40),
    base_sha VARCHAR(40),
    policy_digest VARCHAR(64),
    config_digest VARCHAR(64),
    context_digest VARCHAR(64),
    evidence_digest VARCHAR(64),
    actor_digest VARCHAR(64) CHECK (actor_digest IS NULL OR actor_digest ~ '^[a-f0-9]{64}$'),
    verification_status TEXT NOT NULL DEFAULT 'insufficient'
      CHECK (verification_status IN ('confirmed', 'contradicted', 'insufficient')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_pr_lifecycle_events_history_idx
    ON review_pr_lifecycle_events (lifecycle_id, created_at, event_id);

  CREATE TABLE IF NOT EXISTS review_semantic_finding_events (
    finding_event_id UUID PRIMARY KEY,
    lifecycle_id UUID NOT NULL REFERENCES review_pr_lifecycles(lifecycle_id),
    reservation_id UUID NOT NULL REFERENCES review_pr_review_reservations(reservation_id),
    event_key TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    execution_attempt INTEGER NOT NULL CHECK (execution_attempt > 0),
    fingerprint TEXT NOT NULL,
    path TEXT NOT NULL,
    region_start INTEGER CHECK (region_start IS NULL OR region_start > 0),
    region_end INTEGER CHECK (region_end IS NULL OR region_end > 0),
    first_seen_head VARCHAR(40) NOT NULL CHECK (first_seen_head ~ '^[a-f0-9]{40}$'),
    last_seen_head VARCHAR(40) NOT NULL CHECK (last_seen_head ~ '^[a-f0-9]{40}$'),
    affected_context_digest VARCHAR(64) NOT NULL CHECK (affected_context_digest ~ '^[a-f0-9]{64}$'),
    source_severity TEXT NOT NULL,
    effective_severity TEXT NOT NULL,
    disposition TEXT NOT NULL,
    blocking BOOLEAN NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'insufficient'
      CHECK (verification_status IN ('confirmed', 'contradicted', 'insufficient')),
    evidence_digest VARCHAR(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
    source_evidence JSONB NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_semantic_finding_history_idx
    ON review_semantic_finding_events (lifecycle_id, fingerprint, created_at, finding_event_id);
  CREATE INDEX IF NOT EXISTS review_semantic_finding_run_idx
    ON review_semantic_finding_events (run_id, execution_attempt);
`;
