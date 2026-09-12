import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  parseReviewYetiEventV1,
  REVIEW_EVENT_SCHEMA,
  type ReviewYetiLifecycleEventV1,
} from '../events/reviewYetiEvent';

export interface ReviewEventQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
}

export interface ReviewEventTransactionClient extends ReviewEventQueryable {
  release(): void;
}

export interface ReviewEventPool {
  connect(): Promise<ReviewEventTransactionClient>;
}

export type ReviewLifecycleEventsMode = 'enabled' | 'disabled';

export interface ReviewLifecycleEventsOptions {
  /** Lifecycle intents are an explicit observer mode, never inferred from pool shape. */
  lifecycleEvents: ReviewLifecycleEventsMode;
}

export interface ReviewEventRetentionOptions {
  /** Retention is opt-in. Omitted and disabled options are no-ops. */
  enabled?: boolean;
  /** Published acknowledgements older than this age may be pruned. */
  maxAgeMs?: number;
  /** Maximum number of locked/deleted rows per maintenance transaction. */
  batchSize?: number;
}

export interface ReviewEventRepositoryOptions {
  retention?: ReviewEventRetentionOptions;
}

export const REVIEW_LIFECYCLE_EVENT_BATCH_MAX = 256;
const REVIEW_LIFECYCLE_RUN_LOCK_PREFIX = 'review-lifecycle-run:';

export class ReviewLifecycleBatchLockUnavailableError extends Error {
  constructor() {
    super('Review lifecycle batch lock is temporarily unavailable');
    this.name = 'ReviewLifecycleBatchLockUnavailableError';
  }
}

function isPostgresLockNotAvailable(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '55P03';
}

export function requireLifecycleEventsMode(
  options: ReviewLifecycleEventsOptions | undefined,
  component: string,
): boolean {
  if (options?.lifecycleEvents !== 'enabled' && options?.lifecycleEvents !== 'disabled') {
    throw new Error(`${component} requires an explicit lifecycle event mode`);
  }
  return options.lifecycleEvents === 'enabled';
}

/**
 * The lifecycle outbox is an observation boundary.  It has no state that can
 * allocate work, execute a review, complete a review, or publish a gate.
 * Installation is additive and safe to run repeatedly under PostgresStore's
 * existing transaction/advisory lock.
 */
export const REVIEW_EVENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_event_sequence_counters (
    run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
    next_sequence BIGINT NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS review_event_outbox (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
    attempt_id TEXT NOT NULL,
    repository_id BIGINT NOT NULL CHECK (repository_id > 0),
    pr_number INTEGER NOT NULL CHECK (pr_number > 0),
    base_sha VARCHAR(40) NOT NULL CHECK (base_sha ~ '^[a-fA-F0-9]{40}$'),
    head_sha VARCHAR(40) NOT NULL CHECK (head_sha ~ '^[a-fA-F0-9]{40}$'),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    schema TEXT NOT NULL CHECK (schema = 'review-yeti-event.v1'),
    event_kind TEXT NOT NULL CHECK (event_kind LIKE 'review.lifecycle.%'),
    occurred_at TIMESTAMPTZ NOT NULL,
    correlation_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility = 'internal'),
    payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'published')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    publish_acknowledged_at TIMESTAMPTZ,
    publish_ack VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (run_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS review_event_claim_idx
    ON review_event_outbox (state, next_attempt_at, lease_expires_at, created_at);
  CREATE INDEX IF NOT EXISTS review_event_run_idx
    ON review_event_outbox (run_id, sequence);
  CREATE INDEX IF NOT EXISTS review_event_retention_idx
    ON review_event_outbox (publish_acknowledged_at, event_id)
    WHERE state = 'published' AND publish_acknowledged_at IS NOT NULL;
`;

export type ReviewLifecycleEventInput = Omit<ReviewYetiLifecycleEventV1, 'sequence'> & {
  /** The durable repository allocates this value; a supplied value is only a
   * parser placeholder and is never used as the persisted sequence. */
  sequence?: number;
};

export type ReviewEventState = 'pending' | 'claimed' | 'published';

export interface ReviewEventOutboxRecord {
  eventId: string;
  runId: string;
  attemptId: string;
  repositoryId: number;
  prNumber: number;
  sequence: number;
  state: ReviewEventState;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  nextAttemptAt: number;
  publishAcknowledgedAt?: number;
  publishAck?: string;
  createdAt: number;
  updatedAt: number;
  event: ReviewYetiLifecycleEventV1;
}

export interface ReviewEventClaim extends ReviewEventOutboxRecord {
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface LifecycleEventBuilderInput {
  eventKind: string;
  repositoryId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  attemptId: string;
  runId: string;
  correlationId: string;
  traceId: string;
  data?: ReviewYetiLifecycleEventV1['data'];
  occurredAt?: string;
  eventId?: string;
}

export interface AppendLifecycleEventForRunInput {
  runId: string;
  eventKind: string;
  data?: ReviewYetiLifecycleEventV1['data'];
  occurredAt?: number;
  attemptId?: string;
  correlationId?: string;
  traceId?: string;
  eventId?: string;
}

export interface AppendLifecycleEventBatchInput extends AppendLifecycleEventForRunInput {
  /** Stable caller-owned ordering for multiple events belonging to one run. */
  orderingKey?: string;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_MAX = (1n << 48n) - 1n;

function newUlid(now = Date.now()): string {
  const timestamp = BigInt(Math.max(0, Math.min(Number(ULID_TIME_MAX), Math.trunc(now))));
  let encoded = '';
  for (let shift = 45n; shift >= 0n; shift -= 5n) {
    encoded += ULID_ALPHABET[Number((timestamp >> shift) & 31n)];
  }
  const random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  for (let shift = 75n; shift >= 0n; shift -= 5n) {
    encoded += ULID_ALPHABET[Number((random >> shift) & 31n)];
  }
  return encoded;
}

export function buildLifecycleEvent(input: LifecycleEventBuilderInput): ReviewLifecycleEventInput {
  return {
    schema: REVIEW_EVENT_SCHEMA,
    event_id: input.eventId || newUlid(),
    event_kind: input.eventKind,
    occurred_at: input.occurredAt || new Date().toISOString(),
    repository_id: input.repositoryId,
    pr_number: input.prNumber,
    base_sha: input.baseSha,
    head_sha: input.headSha,
    attempt_id: input.attemptId,
    run_id: input.runId,
    sequence: 1,
    correlation_id: input.correlationId,
    trace_id: input.traceId,
    visibility: 'internal',
    data: input.data || {},
  };
}

function milliseconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const millisecondsValue = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(millisecondsValue) ? millisecondsValue : undefined;
}

function parsedLifecycleEvent(event: ReviewLifecycleEventInput): ReviewYetiLifecycleEventV1 {
  const parsed = parseReviewYetiEventV1({ ...event, sequence: event.sequence ?? 1 });
  // JSONB persists a JSON value, so logical replay identity must compare that
  // same value. In particular, optional properties whose value is undefined
  // are absent after persistence. The first parse rejects non-JSON values;
  // reparsing the JSON round trip retains the schema and size guarantees.
  const normalized = parseReviewYetiEventV1(JSON.parse(JSON.stringify(parsed)));
  if (!normalized.event_kind.startsWith('review.lifecycle.')) {
    throw new Error('Only review lifecycle events may be persisted in the lifecycle outbox');
  }
  return normalized as ReviewYetiLifecycleEventV1;
}

function eventWithoutSequence(event: ReviewYetiLifecycleEventV1): Omit<ReviewYetiLifecycleEventV1, 'sequence'> {
  const { sequence: _sequence, ...withoutSequence } = event;
  return withoutSequence;
}

function sameLogicalEvent(left: ReviewYetiLifecycleEventV1, right: ReviewYetiLifecycleEventV1): boolean {
  return isDeepStrictEqual(eventWithoutSequence(left), eventWithoutSequence(right));
}

function rowToRecord(row: any): ReviewEventOutboxRecord {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const event = parseReviewYetiEventV1(payload) as ReviewYetiLifecycleEventV1;
  return {
    eventId: String(row.event_id),
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    repositoryId: Number(row.repository_id),
    prNumber: Number(row.pr_number),
    sequence: Number(row.sequence),
    state: row.state as ReviewEventState,
    attemptCount: Number(row.attempt_count || 0),
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: milliseconds(row.lease_expires_at),
    nextAttemptAt: milliseconds(row.next_attempt_at) || 0,
    publishAcknowledgedAt: milliseconds(row.publish_acknowledged_at),
    publishAck: row.publish_ack || undefined,
    createdAt: milliseconds(row.created_at) || 0,
    updatedAt: milliseconds(row.updated_at) || 0,
    event,
  };
}

/**
 * Append an already-validated lifecycle intent to the caller's transaction.
 * This function deliberately never begins, commits, rolls back, leases, or
 * acknowledges publication. A caller that rolls back its authoritative state
 * transition rolls back the event intent and counter allocation as well.
 */
export async function appendLifecycleEvent(
  client: ReviewEventQueryable,
  input: ReviewLifecycleEventInput,
): Promise<ReviewEventOutboxRecord> {
  const candidate = parsedLifecycleEvent(input);
  // Every producer first acquires the review_runs reference lock that the
  // counter/outbox foreign keys will require, then joins the per-run advisory
  // lock domain, and only then locks an event identity. This avoids holding an
  // advisory lock while waiting behind a writer that already owns the run row.
  // Materialized CTEs preserve that ordering in the existing single round trip.
  await client.query(
    `WITH run_reference AS MATERIALIZED (
       SELECT run_id
         FROM review_runs
        WHERE run_id = $1
        FOR KEY SHARE
     ),
     run_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($2, 0))
         FROM run_reference
     )
     SELECT pg_advisory_xact_lock(hashtextextended($3, 0))
       FROM run_lock`,
    [candidate.run_id, `${REVIEW_LIFECYCLE_RUN_LOCK_PREFIX}${candidate.run_id}`, candidate.event_id],
  );
  const existing = await client.query(
    'SELECT * FROM review_event_outbox WHERE event_id = $1 FOR UPDATE',
    [candidate.event_id],
  );
  if (existing.rows.length > 0) {
    const record = rowToRecord(existing.rows[0]);
    if (!sameLogicalEvent(record.event, candidate)) {
      throw new Error('Review lifecycle event identity conflict');
    }
    return record;
  }

  // The counter is the only sequence allocator. It is intentionally separate
  // from retained outbox rows, so replay/retention cleanup can never cause a
  // MAX(sequence)+1 collision or allow two concurrent callers to share a
  // sequence. Gaps after a failed insert are safe and remain in the rolled-back
  // transaction when the caller aborts.
  const counter = await client.query(
    `INSERT INTO review_event_sequence_counters (run_id, next_sequence, updated_at)
       VALUES ($1, 1, to_timestamp($2 / 1000.0))
     ON CONFLICT (run_id) DO UPDATE
       SET next_sequence = review_event_sequence_counters.next_sequence + 1,
           updated_at = EXCLUDED.updated_at
     RETURNING next_sequence`,
    [candidate.run_id, Date.parse(candidate.occurred_at)],
  );
  const sequence = Number(counter.rows[0]?.next_sequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Review lifecycle event sequence allocation failed');
  }
  const event = parsedLifecycleEvent({ ...candidate, sequence });
  const inserted = await client.query(
    `INSERT INTO review_event_outbox
      (event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha,
       sequence, schema, event_kind, occurred_at, correlation_id, trace_id,
       visibility, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       'pending', 0, $11, $11, $11)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING *`,
    [
      event.event_id, event.run_id, event.attempt_id, event.repository_id, event.pr_number,
      event.base_sha, event.head_sha, event.sequence, event.schema, event.event_kind,
      event.occurred_at, event.correlation_id, event.trace_id, event.visibility, JSON.stringify(event),
    ],
  );
  if (inserted.rows.length === 1) return rowToRecord(inserted.rows[0]);

  const concurrent = await client.query(
    'SELECT * FROM review_event_outbox WHERE event_id = $1 FOR UPDATE',
    [event.event_id],
  );
  const record = concurrent.rows[0] && rowToRecord(concurrent.rows[0]);
  if (!record || !sameLogicalEvent(record.event, candidate)) {
    throw new Error('Review lifecycle event identity conflict');
  }
  return record;
}

/**
 * Build the closed envelope from authoritative run metadata already held in
 * the caller's transaction. The lookup is deliberately read-only; callers
 * retain the transaction and locks for the state transition plus append.
 */
export async function appendLifecycleEventForRun(
  client: ReviewEventQueryable,
  input: AppendLifecycleEventForRunInput,
): Promise<ReviewEventOutboxRecord> {
  const row = (await client.query(
    `SELECT runs.run_id, runs.repository_id, runs.pr_number, runs.base_sha, runs.head_sha,
            runs.attempt, runs.effective_policy_digest,
            COALESCE(outbox.execution_attempt, 0) + 1 AS execution_attempt
       FROM review_runs AS runs
       LEFT JOIN review_dispatch_outbox AS outbox USING (run_id)
      WHERE runs.run_id = $1`,
    [input.runId],
  )).rows[0];
  if (!row) {
    throw new Error(`Review lifecycle run metadata is unavailable for ${input.runId}`);
  }
  const repositoryId = Number(row.repository_id);
  const prNumber = Number(row.pr_number);
  const baseSha = typeof row.base_sha === 'string' ? row.base_sha : '';
  const headSha = typeof row.head_sha === 'string' ? row.head_sha : '';
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(prNumber) || prNumber <= 0
    || !/^[a-f0-9]{40}$/iu.test(baseSha)
    || !/^[a-f0-9]{40}$/iu.test(headSha)) {
    throw new Error(`Review lifecycle run metadata is incomplete for ${input.runId}`);
  }
  const occurredAt = input.occurredAt ?? Date.now();
  const attemptId = input.attemptId || `${input.runId}-g${Number(row.attempt || 0)}-e${Number(row.execution_attempt || 1)}`;
  return appendLifecycleEvent(client, buildLifecycleEvent({
    eventKind: input.eventKind,
    eventId: input.eventId,
    occurredAt: new Date(occurredAt).toISOString(),
    repositoryId,
    prNumber,
    baseSha,
    headSha,
    attemptId,
    runId: String(row.run_id),
    correlationId: input.correlationId || String(row.run_id),
    traceId: input.traceId || String(row.run_id),
    data: { policy_digest: row.effective_policy_digest, ...input.data },
  }));
}

/**
 * Append a bounded set of lifecycle intents in one transaction shape. The
 * caller owns the transaction; this helper only takes deterministic per-run
 * advisory locks, advances each run counter once, and inserts the exact
 * envelopes built from authoritative run metadata.
 */
export async function appendLifecycleEventsForRuns(
  client: ReviewEventQueryable,
  inputs: readonly AppendLifecycleEventBatchInput[],
): Promise<ReviewEventOutboxRecord[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > REVIEW_LIFECYCLE_EVENT_BATCH_MAX) {
    throw new Error(`Review lifecycle event batch exceeds maximum of ${REVIEW_LIFECYCLE_EVENT_BATCH_MAX}`);
  }

  const ordered = inputs.map((input, index) => ({ input, index })).sort((left, right) => {
    const runOrder = left.input.runId.localeCompare(right.input.runId);
    if (runOrder !== 0) return runOrder;
    const keyOrder = (left.input.orderingKey || '').localeCompare(right.input.orderingKey || '');
    return keyOrder !== 0 ? keyOrder : left.index - right.index;
  });
  const runIds = Array.from(new Set(ordered.map(({ input }) => input.runId)));

  let metadata: { rows: any[]; rowCount?: number };
  try {
    metadata = await client.query(
      `WITH requested AS MATERIALIZED (
         SELECT requested.run_id, requested.ordinality
           FROM unnest($1::text[]) WITH ORDINALITY AS requested(run_id, ordinality)
       ),
       run_references AS MATERIALIZED (
         SELECT requested.run_id AS requested_run_id, requested.ordinality,
                runs.run_id, runs.repository_id, runs.pr_number, runs.base_sha, runs.head_sha,
                runs.attempt, runs.effective_policy_digest,
                COALESCE(outbox.execution_attempt, 0) + 1 AS execution_attempt
           FROM requested
           JOIN review_runs AS runs ON runs.run_id = requested.run_id
           LEFT JOIN review_dispatch_outbox AS outbox ON outbox.run_id = runs.run_id
          ORDER BY requested.ordinality
          FOR KEY SHARE OF runs NOWAIT
       ),
       locks AS MATERIALIZED (
         SELECT run_references.*,
                pg_try_advisory_xact_lock(
                  hashtextextended($2 || run_references.run_id, 0)
                ) AS acquired
           FROM run_references
          ORDER BY run_references.ordinality
       )
       SELECT requested.run_id AS requested_run_id, locks.acquired,
              locks.run_id, locks.repository_id, locks.pr_number, locks.base_sha, locks.head_sha,
              locks.attempt, locks.effective_policy_digest, locks.execution_attempt
         FROM requested
         LEFT JOIN locks ON locks.requested_run_id = requested.run_id
        ORDER BY requested.ordinality`,
      [runIds, REVIEW_LIFECYCLE_RUN_LOCK_PREFIX],
    );
  } catch (error) {
    // A batch must release any earlier sorted references before a writer that
    // owns a later run can request one of them. The caller's bounded retry loop
    // rolls back the whole authoritative mutation. Only SQLSTATE 55P03 is a
    // contention signal; every other database failure remains fatal.
    if (isPostgresLockNotAvailable(error)) {
      throw new ReviewLifecycleBatchLockUnavailableError();
    }
    throw error;
  }
  const metadataByRun = new Map(metadata.rows
    .filter((row) => row.run_id)
    .map((row) => [String(row.requested_run_id), row]));
  if (metadataByRun.size !== runIds.length) {
    const missingRunId = runIds.find((runId) => !metadataByRun.has(runId));
    throw new Error(`Review lifecycle run metadata is unavailable for ${missingRunId}`);
  }
  if (metadata.rows.some((row) => row.acquired !== true)) {
    throw new ReviewLifecycleBatchLockUnavailableError();
  }

  const candidates = ordered.map(({ input }) => {
    const row = metadataByRun.get(input.runId)!;
    const repositoryId = Number(row.repository_id);
    const prNumber = Number(row.pr_number);
    const baseSha = typeof row.base_sha === 'string' ? row.base_sha : '';
    const headSha = typeof row.head_sha === 'string' ? row.head_sha : '';
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
      || !Number.isSafeInteger(prNumber) || prNumber <= 0
      || !/^[a-f0-9]{40}$/iu.test(baseSha)
      || !/^[a-f0-9]{40}$/iu.test(headSha)) {
      throw new Error(`Review lifecycle run metadata is incomplete for ${input.runId}`);
    }
    const occurredAt = input.occurredAt ?? Date.now();
    const candidate = parsedLifecycleEvent(buildLifecycleEvent({
      eventKind: input.eventKind,
      eventId: input.eventId,
      occurredAt: new Date(occurredAt).toISOString(),
      repositoryId,
      prNumber,
      baseSha,
      headSha,
      attemptId: input.attemptId || `${input.runId}-g${Number(row.attempt || 0)}-e${Number(row.execution_attempt || 1)}`,
      runId: String(row.run_id),
      correlationId: input.correlationId || String(row.run_id),
      traceId: input.traceId || String(row.run_id),
      data: { policy_digest: row.effective_policy_digest, ...input.data },
    }));
    return {
      candidate,
      runId: input.runId,
      occurredAt: Date.parse(candidate.occurred_at),
    };
  });

  const uniqueCandidates = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    const duplicate = uniqueCandidates.get(candidate.candidate.event_id);
    if (duplicate && !sameLogicalEvent(duplicate.candidate, candidate.candidate)) {
      throw new Error('Review lifecycle event identity conflict');
    }
    if (!duplicate) uniqueCandidates.set(candidate.candidate.event_id, candidate);
  }
  const eventIds = Array.from(uniqueCandidates.keys()).sort((left, right) => left.localeCompare(right));
  const replayLookup = await client.query(
    `WITH requested AS MATERIALIZED (
       SELECT requested.event_id, requested.ordinality
         FROM unnest($1::text[]) WITH ORDINALITY AS requested(event_id, ordinality)
     ),
     locks AS MATERIALIZED (
       SELECT requested.event_id, requested.ordinality,
              pg_try_advisory_xact_lock(
                hashtextextended(requested.event_id, 0)
              ) AS acquired
         FROM requested
        ORDER BY requested.ordinality
     ),
     existing AS (
       SELECT outbox.*
         FROM review_event_outbox AS outbox
        WHERE outbox.event_id = ANY($1::text[])
     )
     SELECT COALESCE((SELECT bool_and(acquired) FROM locks), TRUE) AS acquired,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(existing) ORDER BY existing.event_id) FROM existing),
              '[]'::jsonb
            ) AS existing`,
    [eventIds],
  );
  const replayRow = replayLookup.rows[0];
  if (replayRow?.acquired !== true) {
    throw new ReviewLifecycleBatchLockUnavailableError();
  }
  const existingRows = Array.isArray(replayRow.existing)
    ? replayRow.existing
    : JSON.parse(String(replayRow.existing || '[]'));
  const existingByEventId = new Map<string, ReviewEventOutboxRecord>(
    existingRows.map((row: any) => {
      const record = rowToRecord(row);
      return [record.eventId, record];
    }),
  );
  for (const { candidate } of uniqueCandidates.values()) {
    const existing = existingByEventId.get(candidate.event_id);
    if (existing && !sameLogicalEvent(existing.event, candidate)) {
      throw new Error('Review lifecycle event identity conflict');
    }
  }

  const newCandidates = Array.from(uniqueCandidates.values())
    .filter(({ candidate }) => !existingByEventId.has(candidate.event_id));
  if (newCandidates.length === 0) {
    return candidates.map(({ candidate }) => existingByEventId.get(candidate.event_id)!);
  }

  const allocationByRun = new Map<string, { count: number; updatedAt: number }>();
  for (const candidate of newCandidates) {
    const allocation = allocationByRun.get(candidate.runId);
    if (allocation) {
      allocation.count += 1;
      allocation.updatedAt = candidate.occurredAt;
    } else {
      allocationByRun.set(candidate.runId, { count: 1, updatedAt: candidate.occurredAt });
    }
  }
  const allocationRunIds = runIds.filter((runId) => allocationByRun.has(runId));
  const counts = allocationRunIds.map((runId) => allocationByRun.get(runId)!.count);
  const updatedAt = allocationRunIds.map((runId) => allocationByRun.get(runId)!.updatedAt);
  const counters = await client.query(
    `INSERT INTO review_event_sequence_counters (run_id, next_sequence, updated_at)
       SELECT requested.run_id, requested.event_count,
              to_timestamp(requested.updated_at_ms / 1000.0)
         FROM unnest($1::text[], $2::bigint[], $3::double precision[])
           AS requested(run_id, event_count, updated_at_ms)
     ON CONFLICT (run_id) DO UPDATE
       SET next_sequence = review_event_sequence_counters.next_sequence + EXCLUDED.next_sequence,
           updated_at = EXCLUDED.updated_at
     RETURNING run_id, next_sequence`,
    [allocationRunIds, counts, updatedAt],
  );
  const nextByRun = new Map(counters.rows.map((row) => [String(row.run_id), Number(row.next_sequence)]));
  if (nextByRun.size !== allocationRunIds.length
    || allocationRunIds.some((runId) => !Number.isSafeInteger(nextByRun.get(runId)))) {
    throw new Error('Review lifecycle event sequence allocation failed');
  }

  const offsets = new Map(allocationRunIds
    .map((runId, index) => [runId, nextByRun.get(runId)! - counts[index]]));
  const positions = new Map<string, number>();
  const events = newCandidates.map(({ candidate, runId }) => {
    const position = positions.get(runId) || 0;
    positions.set(runId, position + 1);
    return parsedLifecycleEvent({ ...candidate, sequence: offsets.get(runId)! + position + 1 });
  });
  const inserted = await client.query(
    `INSERT INTO review_event_outbox
      (event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha,
       sequence, schema, event_kind, occurred_at, correlation_id, trace_id,
       visibility, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
     SELECT event_rows.event_id, event_rows.run_id, event_rows.attempt_id,
            event_rows.repository_id, event_rows.pr_number, event_rows.base_sha, event_rows.head_sha,
            event_rows.sequence, event_rows.schema, event_rows.event_kind,
            to_timestamp(event_rows.occurred_at_ms / 1000.0), event_rows.correlation_id,
            event_rows.trace_id, event_rows.visibility, event_rows.payload,
            'pending', 0, to_timestamp(event_rows.occurred_at_ms / 1000.0),
            to_timestamp(event_rows.occurred_at_ms / 1000.0), to_timestamp(event_rows.occurred_at_ms / 1000.0)
       FROM jsonb_to_recordset($1::jsonb) AS event_rows(
         event_id text, run_id text, attempt_id text, repository_id bigint, pr_number integer,
         base_sha text, head_sha text, sequence bigint, schema text, event_kind text,
         occurred_at_ms double precision, correlation_id text, trace_id text,
         visibility text, payload jsonb)
     RETURNING *`,
    [JSON.stringify(events.map((event) => ({
      event_id: event.event_id,
      run_id: event.run_id,
      attempt_id: event.attempt_id,
      repository_id: event.repository_id,
      pr_number: event.pr_number,
      base_sha: event.base_sha,
      head_sha: event.head_sha,
      sequence: event.sequence,
      schema: event.schema,
      event_kind: event.event_kind,
      occurred_at_ms: Date.parse(event.occurred_at),
      correlation_id: event.correlation_id,
      trace_id: event.trace_id,
      visibility: event.visibility,
      payload: event,
    })))],
  );
  if (inserted.rows.length !== events.length) {
    throw new Error('Review lifecycle batch append did not persist all events');
  }
  const recordsByEventId = new Map(existingByEventId);
  for (const row of inserted.rows) {
    const record = rowToRecord(row);
    recordsByEventId.set(record.eventId, record);
  }
  return candidates.map(({ candidate }) => {
    const record = recordsByEventId.get(candidate.event_id);
    if (!record) throw new Error('Review lifecycle batch append response is incomplete');
    return record;
  });
}

export class PostgresReviewEventRepository {
  constructor(
    private readonly pool: ReviewEventPool,
    private readonly options: ReviewEventRepositoryOptions = {},
  ) {}

  private async transaction<T>(operation: (client: ReviewEventTransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewEventClaim | null> {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(workerId)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300_000) {
      throw new Error('Invalid review event lease');
    }
    return this.transaction(async (client) => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT event_id
             FROM review_event_outbox
            WHERE (state = 'pending' AND next_attempt_at <= to_timestamp($2 / 1000.0))
               OR (state = 'claimed' AND lease_expires_at <= to_timestamp($2 / 1000.0))
            ORDER BY next_attempt_at, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE review_event_outbox AS outbox
            SET state = 'claimed', lease_owner = $1,
                lease_expires_at = to_timestamp(($2 + $3) / 1000.0),
                attempt_count = attempt_count + 1, updated_at = to_timestamp($2 / 1000.0)
           FROM candidate
          WHERE outbox.event_id = candidate.event_id
          RETURNING outbox.*`,
        [workerId, now, leaseMs],
      );
      if (result.rows.length === 0) return null;
      const record = rowToRecord(result.rows[0]);
      return { ...record, leaseOwner: workerId, leaseExpiresAt: record.leaseExpiresAt || now + leaseMs };
    });
  }

  async heartbeat(eventId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE review_event_outbox
            SET lease_expires_at = to_timestamp(($3 + $4) / 1000.0), updated_at = to_timestamp($3 / 1000.0)
          WHERE event_id = $1 AND lease_owner = $2 AND state = 'claimed'
            AND lease_expires_at > to_timestamp($3 / 1000.0)
          RETURNING event_id`,
        [eventId, workerId, now, leaseMs],
      );
      return result.rows.length > 0;
    });
  }

  async markPublished(eventId: string, workerId: string, now: number, publishAck = 'acknowledged'): Promise<boolean> {
    if (publishAck.length > 512) throw new Error('Review event publication acknowledgement is too large');
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE review_event_outbox
            SET state = 'published', lease_owner = NULL, lease_expires_at = NULL,
                publish_acknowledged_at = to_timestamp($3 / 1000.0), publish_ack = $4,
                updated_at = to_timestamp($3 / 1000.0)
          WHERE event_id = $1 AND lease_owner = $2 AND state = 'claimed'
            AND lease_expires_at > to_timestamp($3 / 1000.0)
          RETURNING event_id`,
        [eventId, workerId, now, publishAck],
      );
      return result.rows.length > 0;
    });
  }

  async releaseForRetry(eventId: string, workerId: string, now: number, delayMs: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE review_event_outbox
            SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL,
                next_attempt_at = to_timestamp(($3 + $4) / 1000.0), updated_at = to_timestamp($3 / 1000.0)
          WHERE event_id = $1 AND lease_owner = $2 AND state = 'claimed'
            AND lease_expires_at > to_timestamp($3 / 1000.0)
          RETURNING event_id`,
        [eventId, workerId, now, delayMs],
      );
      return result.rows.length > 0;
    });
  }

  /**
   * Prune only acknowledged, published lifecycle rows when an operator has
   * explicitly enabled retention. Sequence counters are intentionally not
   * touched: they are the durable per-run high-water mark after outbox rows
   * have been removed.
   */
  async pruneAcknowledgedPublished(now = Date.now()): Promise<number> {
    const retention = this.options.retention;
    if (retention?.enabled !== true) return 0;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid review event retention clock');
    const maxAgeMs = retention.maxAgeMs;
    const batchSize = retention.batchSize;
    if (typeof maxAgeMs !== 'number' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0
      || typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new Error('Invalid review event retention bounds');
    }
    const cutoff = now - maxAgeMs;
    return this.transaction(async (client) => {
      const result = await client.query(
        `WITH eligible AS (
           SELECT event_id
             FROM review_event_outbox
            WHERE state = 'published'
              AND publish_acknowledged_at IS NOT NULL
              AND publish_acknowledged_at <= to_timestamp($1 / 1000.0)
            ORDER BY publish_acknowledged_at, event_id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         DELETE FROM review_event_outbox AS outbox
          USING eligible
          WHERE outbox.event_id = eligible.event_id
         RETURNING outbox.event_id`,
        [cutoff, batchSize],
      );
      return result.rows.length;
    });
  }
}
