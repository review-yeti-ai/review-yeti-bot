import { z } from 'zod';
import { PI_STAGES } from '../review/piWorkflow';

const runIdSchema = z.string().regex(/^run_[a-f0-9]{32}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/iu);
const digest = z.string().regex(/^[a-f0-9]{64}$/iu);
const integer = z.preprocess(value => typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value,
  z.number().int().nonnegative().safe());
const positiveInteger = integer.refine(value => value > 0);
const timestamp = z.preprocess(value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true }));
// Dispatcher terminalization is distinct from the older Pi stage machine.
// Keep both durable vocabularies without changing the executable Pi contract.
const statuses = ['queued', 'running', 'publishing', 'succeeded', 'failed', 'cancelled', 'superseded', 'terminal'] as const;
const snapshotStages = [...PI_STAGES, 'terminal'] as const;
const gateStates = ['queued', 'in_progress', 'success', 'failure', 'cancelled', 'timed_out'] as const;
const gateReasons = ['review-pending', 'review-deadline-exceeded', 'candidate-superseded', 'pull-request-closed',
  'invalid-evidence', 'infrastructure-failure', 'incomplete-review', 'blocking-findings', 'clean-review',
  'central-exemption', 'human-accepted-risk'] as const;
const completionStates = ['pending', 'claimed', 'dispatched', 'completed', 'error', 'superseded', 'terminal'] as const;

export interface ReviewSnapshotScope {
  repositoryIds: readonly number[];
  runIds?: readonly string[];
}

export interface ReviewSnapshotQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type ReviewSnapshotTerminalClass = 'review_verdict' | 'provider_failure' | 'transport_failure'
  | 'publication_failure' | 'internal_failure' | 'pr_terminal' | 'superseded' | 'unknown';

export interface ReviewEventSnapshot {
  schema: 'review-yeti-snapshot.v1';
  runId: string;
  repositoryId: number;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  status: typeof statuses[number];
  stage: typeof snapshotStages[number];
  attempt: number;
  /** Compatibility high-water mark; never treat it as PR aggregate order. */
  lifecycleSequenceDomain: 'legacy_run_v1';
  lifecycleSequence: number;
  terminalClass: ReviewSnapshotTerminalClass | null;
  resultDigest: string | null;
  gate: { attemptId: string; checkId: number | null; expectedAppId: number;
    state: typeof gateStates[number]; published: boolean; reason: typeof gateReasons[number] | null } | null;
  completion: { state: typeof completionStates[number]; validationRequestId: string } | null;
  createdAt: string;
  updatedAt: string;
}

const scopeSchema = z.object({ repositoryIds: z.array(z.number().int().positive().safe()).max(256),
  runIds: z.array(runIdSchema).max(256).optional() });
const rowSchema = z.object({
  run_id: runIdSchema, repository_id: positiveInteger, owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u), pr_number: positiveInteger,
  base_sha: sha, head_sha: sha, status: z.enum(statuses), stage: z.enum(snapshotStages), attempt: integer,
  result_digest: digest.nullable(), lifecycle_sequence: integer,
  created_at: timestamp, updated_at: timestamp,
  gate_attempt_id: identifier.nullable(), gate_check_id: positiveInteger.nullable(),
  gate_app_id: positiveInteger.nullable(), gate_state: z.enum(gateStates).nullable(),
  gate_published: z.boolean().nullable(), gate_reason: z.unknown(),
  completion_status: z.enum(completionStates).nullable(), validation_request_id: identifier.nullable(),
  failure_class: z.unknown(), failure_reason: z.unknown(),
});
type SnapshotRow = z.infer<typeof rowSchema>;

// One statement observes the run, durable sequence counter and delivery state
// from one PostgreSQL MVCC snapshot. Scope is applied before returning a row.
// The gateway never bootstraps schema or allocates event/attempt sequences.
const SNAPSHOT_SQL = `SELECT r.run_id, r.repository_id, r.owner, r.repo, r.pr_number,
    r.base_sha, r.head_sha, r.status, r.stage, r.attempt, r.result_digest,
    r.created_at, r.updated_at, r.failure_diagnostics->>'failureClass' AS failure_class,
    r.failure_diagnostics->>'reason' AS failure_reason,
    COALESCE(s.next_sequence, 0) AS lifecycle_sequence,
    g.attempt_id AS gate_attempt_id, g.check_id AS gate_check_id, g.expected_app_id AS gate_app_id,
    g.desired_state AS gate_state, (g.published_version >= g.desired_version) AS gate_published,
    g.decision->>'reason' AS gate_reason,
    c.status AS completion_status, c.validation_request_id
  FROM review_runs r
  LEFT JOIN review_event_sequence_counters s ON s.run_id = r.run_id
  LEFT JOIN LATERAL (
    SELECT attempt_id, check_id, expected_app_id, desired_state, desired_version, published_version, decision
    FROM review_gate_attempts
    WHERE run_id = r.run_id AND repository_id = r.repository_id AND pr_number = r.pr_number
    ORDER BY current_attempt DESC, review_generation DESC LIMIT 1
  ) g ON TRUE
  LEFT JOIN LATERAL (
    SELECT status, validation_request_id FROM review_completion_outbox
    WHERE run_id = r.run_id AND repository_id = r.repository_id AND pr_number = r.pr_number
      AND base_sha = r.base_sha AND head_sha = r.head_sha
    ORDER BY created_at DESC, completion_id DESC LIMIT 1
  ) c ON TRUE
  WHERE r.run_id = $1 AND r.repository_id = ANY($2::bigint[])
  LIMIT 1`;

function terminalClass(row: SnapshotRow): ReviewSnapshotTerminalClass | null {
  if (row.status === 'superseded' || row.gate_reason === 'candidate-superseded') return 'superseded';
  if (row.status === 'terminal' && row.failure_reason === 'superseded_publisher_owned_check') return 'superseded';
  if (row.gate_reason === 'pull-request-closed') return 'pr_terminal';
  if (['queued', 'running', 'publishing'].includes(row.status)) return null;
  // A review verdict is not necessarily a clean review, nor proof that delivery
  // succeeded. Gate state/reason and completion state remain separate fields.
  if (row.status === 'succeeded') return 'review_verdict';
  if (['failed', 'terminal'].includes(row.status) && row.stage === 'publish') return 'publication_failure';
  if (['failed', 'terminal'].includes(row.status)) {
    if (['transport', 'timeout'].includes(String(row.failure_class))) return 'transport_failure';
    if (['provider_error', 'auth', 'rate_limit', 'malformed_output', 'budget_exhausted'].includes(String(row.failure_class))) {
      return 'provider_failure';
    }
    if (['contract', 'internal_error'].includes(String(row.failure_class))) return 'internal_failure';
    if (row.gate_reason === 'blocking-findings') return 'review_verdict';
  }
  return 'unknown';
}

export class ReviewSnapshotUnavailableError extends Error {
  constructor() { super('Review snapshot unavailable'); this.name = 'ReviewSnapshotUnavailableError'; }
}

export class PostgresReviewEventSnapshotStore {
  constructor(private readonly database: ReviewSnapshotQueryable) {}

  async getSnapshot(runId: string, scope: ReviewSnapshotScope): Promise<ReviewEventSnapshot | null> {
    const allowed = scopeSchema.safeParse(scope);
    if (!runIdSchema.safeParse(runId).success || !allowed.success || !allowed.data.repositoryIds.length
      || (allowed.data.runIds && !allowed.data.runIds.includes(runId))) return null;
    try {
      const result = await this.database.query(SNAPSHOT_SQL, [runId, allowed.data.repositoryIds]);
      if (!result.rows.length) return null;
      const row = rowSchema.parse(result.rows[0]);
      if (row.run_id !== runId || !allowed.data.repositoryIds.includes(row.repository_id)) return null;
      const reason = z.enum(gateReasons).safeParse(row.gate_reason);
      if (row.gate_attempt_id && (row.gate_app_id === null || row.gate_state === null || row.gate_published === null)) {
        throw new ReviewSnapshotUnavailableError();
      }
      if (row.completion_status && !row.validation_request_id) throw new ReviewSnapshotUnavailableError();
      return {
        schema: 'review-yeti-snapshot.v1', runId: row.run_id, repositoryId: row.repository_id,
        repository: `${row.owner}/${row.repo}`, prNumber: row.pr_number,
        baseSha: row.base_sha, headSha: row.head_sha, status: row.status, stage: row.stage,
        attempt: row.attempt, lifecycleSequenceDomain: 'legacy_run_v1', lifecycleSequence: row.lifecycle_sequence,
        terminalClass: terminalClass(row), resultDigest: row.result_digest,
        gate: row.gate_attempt_id ? { attemptId: row.gate_attempt_id, checkId: row.gate_check_id,
          expectedAppId: row.gate_app_id!, state: row.gate_state!, published: row.gate_published!,
          reason: reason.success ? reason.data : null } : null,
        completion: row.completion_status ? { state: row.completion_status,
          validationRequestId: row.validation_request_id! } : null,
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    } catch {
      // Database and validation errors may embed connection strings or stored
      // values. Only this stable category may cross the observation boundary.
      throw new ReviewSnapshotUnavailableError();
    }
  }
}
