/**
 * PostgreSQL DDL Schema for Review Yeti Human-in-the-Loop (HITL) Controls,
 * Verdict Overrides, Prompt Steering Guidance, and Immutable Audit Persistence.
 */

export const REVIEW_HITL_SCHEMA_SQL = `
  -- 1. Immutable Review Audit Trail
  CREATE TABLE IF NOT EXISTS review_audit_events (
    id VARCHAR(255) PRIMARY KEY,
    review_id VARCHAR(255) NOT NULL,
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(64) NOT NULL CHECK (action IN ('finding_dismissed', 'severity_changed', 'verdict_overridden', 'guidance_added')),
    previous_state JSONB,
    new_state JSONB NOT NULL,
    justification TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_audit_events_review_idx
    ON review_audit_events (review_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS review_audit_events_action_idx
    ON review_audit_events (action);

  -- 2. Review Prompt Guidance (Human Steering)
  CREATE TABLE IF NOT EXISTS review_prompt_guidance (
    id VARCHAR(255) PRIMARY KEY,
    review_id VARCHAR(255) NOT NULL,
    guidance_text TEXT NOT NULL,
    target_personas JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_prompt_guidance_review_idx
    ON review_prompt_guidance (review_id, created_at ASC);

  -- 3. Review Verdict Overrides (Authoritative SHIP/BLOCK)
  CREATE TABLE IF NOT EXISTS review_verdict_overrides (
    id VARCHAR(255) PRIMARY KEY,
    review_id VARCHAR(255) NOT NULL,
    override_verdict VARCHAR(32) NOT NULL CHECK (override_verdict IN ('SHIP', 'BLOCK')),
    reason TEXT NOT NULL,
    overridden_by VARCHAR(255) NOT NULL,
    previous_verdict VARCHAR(32),
    gate_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS review_verdict_overrides_review_idx
    ON review_verdict_overrides (review_id, created_at DESC);

  -- 4. Review Finding State Mutations (Dismissal & Severity overrides)
  CREATE TABLE IF NOT EXISTS review_finding_states (
    id VARCHAR(255) PRIMARY KEY,
    review_id VARCHAR(255) NOT NULL,
    finding_id VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'resolved')),
    severity VARCHAR(10) NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
    previous_severity VARCHAR(10),
    dismissed_reason TEXT,
    dismissed_by VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (review_id, finding_id)
  );
  CREATE INDEX IF NOT EXISTS review_finding_states_review_idx
    ON review_finding_states (review_id);
`;
