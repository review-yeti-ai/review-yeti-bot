import { randomBytes } from 'node:crypto';
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
  if (!parsed.event_kind.startsWith('review.lifecycle.')) {
    throw new Error('Only review lifecycle events may be persisted in the lifecycle outbox');
  }
  return parsed as ReviewYetiLifecycleEventV1;
}

function eventWithoutSequence(event: ReviewYetiLifecycleEventV1): string {
  const { sequence: _sequence, ...withoutSequence } = event;
  return JSON.stringify(withoutSequence);
}

function sameLogicalEvent(left: ReviewYetiLifecycleEventV1, right: ReviewYetiLifecycleEventV1): boolean {
  return eventWithoutSequence(left) === eventWithoutSequence(right);
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
  // Serialize retries of the same event identity before the first lookup. A
  // unique constraint still protects the row, but this lock also prevents a
  // concurrent replay from consuming a second counter value before its
  // conflicting insert becomes visible.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [candidate.event_id]);
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

export class PostgresReviewEventRepository {
  constructor(private readonly pool: ReviewEventPool) {}

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
}
