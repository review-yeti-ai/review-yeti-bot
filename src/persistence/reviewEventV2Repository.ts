/**
 * Dormant additive storage for the lifecycle-v2 contract.
 *
 * This module intentionally owns DDL only.  V2 allocation, event append,
 * cutover/readiness, and publication remain deferred to the governed writer
 * slices that can establish the PR-first lock order.
 */
export const REVIEW_EVENT_V2_SEQUENCE_DOMAIN = 'pr_lifecycle_v2' as const;
export const REVIEW_EVENT_V2_SCHEMA = 'review-yeti-event.v2' as const;
export const REVIEW_EVENT_V2_MAX_SAFE_INTEGER = 9007199254740991;
export const REVIEW_EVENT_V2_SEQUENCE_COUNTER_TABLE = 'review_event_v2_sequence_counters' as const;
export const REVIEW_EVENT_V2_OUTBOX_TABLE = 'review_event_v2_outbox' as const;

/**
 * Additive and idempotent PostgreSQL objects for the dormant lifecycle-v2
 * envelope.  No existing v1 table is altered, migrated, backfilled, or
 * relabeled, and no row is created merely by initialization.
 */
export const REVIEW_EVENT_V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_event_v2_sequence_counters (
    repository_id BIGINT NOT NULL
      CHECK (repository_id > 0 AND repository_id <= 9007199254740991),
    pr_number BIGINT NOT NULL
      CHECK (pr_number > 0 AND pr_number <= 9007199254740991),
    next_sequence BIGINT NOT NULL DEFAULT 0
      CHECK (next_sequence >= 0 AND next_sequence <= 9007199254740991),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (repository_id, pr_number)
  );

  CREATE TABLE IF NOT EXISTS review_event_v2_outbox (
    event_id TEXT PRIMARY KEY
      CHECK (event_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL
      CHECK (char_length(attempt_id) BETWEEN 1 AND 256
        AND attempt_id !~ '[[:space:][:cntrl:]]'),
    repository_id BIGINT NOT NULL
      CHECK (repository_id > 0 AND repository_id <= 9007199254740991),
    pr_number BIGINT NOT NULL
      CHECK (pr_number > 0 AND pr_number <= 9007199254740991),
    base_sha VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[a-fA-F0-9]{40}$'),
    head_sha VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[a-fA-F0-9]{40}$'),
    sequence BIGINT NOT NULL
      CHECK (sequence > 0 AND sequence <= 9007199254740991),
    schema TEXT NOT NULL CHECK (schema = 'review-yeti-event.v2'),
    event_kind TEXT NOT NULL CHECK (
      event_kind ~ '^review[.]lifecycle[.][a-z][a-z0-9]*([._-][a-z0-9]+)*$'
      AND event_kind !~ '^review[.]lifecycle[.]v[0-9]+([.]|$)'
    ),
    occurred_at TIMESTAMPTZ NOT NULL,
    sequence_domain TEXT NOT NULL CHECK (sequence_domain = 'pr_lifecycle_v2'),
    correlation_id TEXT NOT NULL
      CHECK (char_length(correlation_id) BETWEEN 1 AND 256
        AND correlation_id !~ '[[:space:][:cntrl:]]'),
    trace_id TEXT NOT NULL
      CHECK (char_length(trace_id) BETWEEN 1 AND 256
        AND trace_id !~ '[[:space:][:cntrl:]]'),
    visibility TEXT NOT NULL CHECK (visibility = 'internal'),
    payload JSONB NOT NULL CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schema' = 'review-yeti-event.v2'
      AND payload->>'event_id' = event_id
      AND payload->>'event_kind' = event_kind
      AND payload->>'repository_id' = repository_id::text
      AND payload->>'pr_number' = pr_number::text
      AND payload->>'base_sha' = base_sha
      AND payload->>'head_sha' = head_sha
      AND payload->>'attempt_id' = attempt_id
      AND payload->>'run_id' = run_id
      AND payload->>'sequence' = sequence::text
      AND payload->>'sequence_domain' = 'pr_lifecycle_v2'
      AND payload->>'correlation_id' = correlation_id
      AND payload->>'trace_id' = trace_id
      AND payload->>'visibility' = 'internal'
      AND jsonb_typeof(payload->'data') = 'object'
    ),
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'claimed', 'published')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    publish_acknowledged_at TIMESTAMPTZ,
    publish_ack VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
      (state = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state IN ('pending', 'published') AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state <> 'published' OR (publish_acknowledged_at IS NOT NULL AND publish_ack IS NOT NULL)),
    CHECK (state = 'published' OR publish_acknowledged_at IS NULL),
    UNIQUE (repository_id, pr_number, sequence)
  );

  CREATE INDEX IF NOT EXISTS review_event_v2_claim_idx
    ON review_event_v2_outbox (state, next_attempt_at, lease_expires_at, created_at);
  CREATE INDEX IF NOT EXISTS review_event_v2_aggregate_idx
    ON review_event_v2_outbox (repository_id, pr_number, sequence);
  CREATE INDEX IF NOT EXISTS review_event_v2_retention_idx
    ON review_event_v2_outbox (publish_acknowledged_at, event_id)
    WHERE state = 'published' AND publish_acknowledged_at IS NOT NULL;
`;
