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
    payload JSONB NOT NULL,
    CONSTRAINT review_event_v2_payload_shape_check CHECK ((
      jsonb_typeof(payload) = 'object'
      AND CASE WHEN jsonb_typeof(payload) = 'object' THEN
        jsonb_array_length(jsonb_path_query_array(payload, '$.*')) = 16
      ELSE FALSE END
      AND payload ?& ARRAY[
        'schema', 'event_id', 'event_kind', 'occurred_at', 'repository_id', 'pr_number',
        'base_sha', 'head_sha', 'attempt_id', 'run_id', 'sequence', 'sequence_domain',
        'correlation_id', 'trace_id', 'visibility', 'data'
      ]
      AND CASE WHEN jsonb_typeof(payload->'data') = 'object' THEN
        jsonb_array_length(jsonb_path_query_array(payload->'data', '$.*')) <= 8
        AND ((payload->'data')
          - 'stage'::text - 'terminal_class'::text - 'result_digest'::text - 'policy_digest'::text
          - 'duration_ms'::text - 'retry_class'::text - 'evidence_pointers'::text - 'timing'::text) = '{}'::jsonb
        AND CASE WHEN payload->'data' ? 'timing' THEN
          jsonb_typeof(payload->'data'->'timing') = 'object'
          AND jsonb_array_length(jsonb_path_query_array(payload->'data'->'timing', '$.*')) <= 4
          AND ((payload->'data'->'timing')
            - 'queued_at'::text - 'started_at'::text - 'completed_at'::text - 'duration_ms'::text) = '{}'::jsonb
        ELSE TRUE END
        AND CASE WHEN payload->'data' ? 'evidence_pointers' THEN
          jsonb_typeof(payload->'data'->'evidence_pointers') = 'array'
          AND jsonb_array_length(payload->'data'->'evidence_pointers') <= 32
        ELSE TRUE END
        AND CASE WHEN payload->'data' ? 'timing' THEN
          CASE WHEN jsonb_typeof(payload->'data'->'timing') = 'object' THEN
            CASE WHEN payload->'data'->'timing' ? 'duration_ms' THEN
              jsonb_typeof(payload->'data'->'timing'->'duration_ms') = 'number'
            ELSE TRUE END
          ELSE FALSE END
        ELSE TRUE END
      ELSE FALSE END
    ) IS TRUE),
    CONSTRAINT review_event_v2_payload_identity_check CHECK ((
      jsonb_typeof(payload->'schema') = 'string'
      AND payload->>'schema' = schema
      AND jsonb_typeof(payload->'event_id') = 'string'
      AND payload->>'event_id' = event_id
      AND jsonb_typeof(payload->'event_kind') = 'string'
      AND payload->>'event_kind' = event_kind
      AND jsonb_typeof(payload->'occurred_at') = 'string'
      AND pg_input_is_valid(payload->>'occurred_at', 'timestamptz')
      AND CASE WHEN pg_input_is_valid(payload->>'occurred_at', 'timestamptz') THEN
        (payload->>'occurred_at')::timestamptz = occurred_at
      ELSE FALSE END
      AND jsonb_typeof(payload->'repository_id') = 'number'
      AND payload->'repository_id' = to_jsonb(repository_id)
      AND jsonb_typeof(payload->'pr_number') = 'number'
      AND payload->'pr_number' = to_jsonb(pr_number)
      AND jsonb_typeof(payload->'base_sha') = 'string'
      AND payload->>'base_sha' = base_sha
      AND jsonb_typeof(payload->'head_sha') = 'string'
      AND payload->>'head_sha' = head_sha
      AND jsonb_typeof(payload->'attempt_id') = 'string'
      AND payload->>'attempt_id' = attempt_id
      AND jsonb_typeof(payload->'run_id') = 'string'
      AND payload->>'run_id' = run_id
      AND jsonb_typeof(payload->'sequence') = 'number'
      AND payload->'sequence' = to_jsonb(sequence)
      AND jsonb_typeof(payload->'sequence_domain') = 'string'
      AND payload->>'sequence_domain' = sequence_domain
      AND jsonb_typeof(payload->'correlation_id') = 'string'
      AND payload->>'correlation_id' = correlation_id
      AND jsonb_typeof(payload->'trace_id') = 'string'
      AND payload->>'trace_id' = trace_id
      AND jsonb_typeof(payload->'visibility') = 'string'
      AND payload->>'visibility' = visibility
    ) IS TRUE),
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
    CONSTRAINT review_event_v2_lease_state_check CHECK ((
      (state = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state IN ('pending', 'published') AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ) IS TRUE),
    CONSTRAINT review_event_v2_ack_state_check CHECK ((
      (state = 'published' AND publish_acknowledged_at IS NOT NULL AND publish_ack IS NOT NULL)
      OR (state IN ('pending', 'claimed') AND publish_acknowledged_at IS NULL AND publish_ack IS NULL)
    ) IS TRUE),
    UNIQUE (repository_id, pr_number, sequence)
  );

  CREATE INDEX IF NOT EXISTS review_event_v2_claim_idx
    ON review_event_v2_outbox (state, next_attempt_at, lease_expires_at, created_at);
  CREATE INDEX IF NOT EXISTS review_event_v2_retention_idx
    ON review_event_v2_outbox (publish_acknowledged_at, event_id)
    WHERE state = 'published' AND publish_acknowledged_at IS NOT NULL;
`;
