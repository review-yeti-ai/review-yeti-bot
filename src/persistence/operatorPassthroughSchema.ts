/** Durable, App-owned SHIP-exemption receipt and two-check publication outbox. */
export const OPERATOR_PASSTHROUGH_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_operator_passthrough_publications (
    publication_id VARCHAR(64) PRIMARY KEY CHECK (publication_id ~ '^[a-f0-9]{64}$'),
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    owner TEXT NOT NULL CHECK (owner ~ '^[A-Za-z0-9_.-]{1,100}$'),
    repo TEXT NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]{1,100}$'),
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    head_sha VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
    base_sha VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
    policy_digest VARCHAR(64) NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
    expected_app_id BIGINT NOT NULL CHECK (expected_app_id > 0),
    publication_sequence INTEGER NOT NULL CHECK (publication_sequence > 0),
    coordinates JSONB NOT NULL,
    audit_digest VARCHAR(64) NOT NULL CHECK (audit_digest ~ '^[a-f0-9]{64}$'),
    review_external_id TEXT NOT NULL UNIQUE,
    gate_external_id TEXT NOT NULL UNIQUE,
    review_check_id BIGINT UNIQUE CHECK (review_check_id > 0),
    review_creation_state TEXT NOT NULL DEFAULT 'reserved'
      CHECK (review_creation_state IN ('reserved','creating','bound','not-created')),
    review_retired_at TIMESTAMPTZ,
    gate_check_id BIGINT UNIQUE CHECK (gate_check_id > 0),
    gate_creation_state TEXT NOT NULL DEFAULT 'reserved'
      CHECK (gate_creation_state IN ('reserved','creating','bound','not-created')),
    gate_retired_at TIMESTAMPTZ,
    retirement_requested_at TIMESTAMPTZ,
    retirement_reason TEXT CHECK (retirement_reason IN ('pause-disabled','normal-review-admitted','candidate-changed')),
    retired_at TIMESTAMPTZ,
    lease_owner TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error_class TEXT CHECK (last_error_class IN ('transport','unknown-create','identity-conflict','client-preparation')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((review_creation_state = 'bound') = (review_check_id IS NOT NULL)),
    CHECK ((gate_creation_state = 'bound') = (gate_check_id IS NOT NULL)),
    CHECK ((retirement_requested_at IS NULL) = (retirement_reason IS NULL)),
    CHECK ((lease_owner IS NULL) = (lease_token IS NULL)),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    UNIQUE (repository_id, pr_number, head_sha, base_sha, policy_digest, expected_app_id, publication_sequence)
  );
  CREATE INDEX IF NOT EXISTS review_operator_passthrough_due_idx
    ON review_operator_passthrough_publications (available_at, lease_expires_at, created_at)
    WHERE (review_creation_state NOT IN ('bound','not-created') OR gate_creation_state NOT IN ('bound','not-created'))
      OR (retirement_requested_at IS NOT NULL AND retired_at IS NULL);
  CREATE TABLE IF NOT EXISTS review_operator_passthrough_events (
    delivery_id TEXT PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 256),
    publication_id VARCHAR(64) NOT NULL REFERENCES review_operator_passthrough_publications(publication_id),
    transport TEXT NOT NULL CHECK (transport IN ('github-app','github-actions-oidc','mcp','service-reconciler')),
    event_name TEXT NOT NULL CHECK (event_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    delivery_digest VARCHAR(64) NOT NULL CHECK (delivery_digest ~ '^[a-f0-9]{64}$'),
    event_audit_digest VARCHAR(64) NOT NULL CHECK (event_audit_digest ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE OR REPLACE FUNCTION review_operator_passthrough_events_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'operator passthrough events are append-only'; END $$;
  DROP TRIGGER IF EXISTS review_operator_passthrough_events_immutable ON review_operator_passthrough_events;
  CREATE TRIGGER review_operator_passthrough_events_immutable
    BEFORE UPDATE OR DELETE ON review_operator_passthrough_events
    FOR EACH ROW EXECUTE FUNCTION review_operator_passthrough_events_immutable();
  CREATE OR REPLACE FUNCTION review_operator_passthrough_guard_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    IF ROW(NEW.publication_id, NEW.repository_id, NEW.owner, NEW.repo, NEW.pr_number, NEW.head_sha,
      NEW.base_sha, NEW.policy_digest, NEW.expected_app_id, NEW.publication_sequence, NEW.coordinates, NEW.audit_digest,
      NEW.review_external_id, NEW.gate_external_id)
      IS DISTINCT FROM ROW(OLD.publication_id, OLD.repository_id, OLD.owner, OLD.repo, OLD.pr_number,
      OLD.head_sha, OLD.base_sha, OLD.policy_digest, OLD.expected_app_id, OLD.publication_sequence, OLD.coordinates, OLD.audit_digest,
      OLD.review_external_id, OLD.gate_external_id)
    THEN RAISE EXCEPTION 'operator passthrough candidate identity is immutable'; END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS review_operator_passthrough_immutable_identity ON review_operator_passthrough_publications;
  CREATE TRIGGER review_operator_passthrough_immutable_identity
    BEFORE UPDATE ON review_operator_passthrough_publications
    FOR EACH ROW EXECUTE FUNCTION review_operator_passthrough_guard_identity();
`;
