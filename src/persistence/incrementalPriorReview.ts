/**
 * REL-1084: the service's one selection of the prior review an incremental
 * re-review may carry forward from. Both the worker's planning endpoint and the
 * trusted completion side call `selectPriorReviewRecord`, so they name the same
 * stored record, and neither accepts a record the worker supplied.
 *
 * Selection is deterministic for a run: the latest stored completion of any
 * other run of the same repository and pull request that was stored BEFORE this
 * run was admitted. A later record cannot appear between planning and
 * completion, so the two reads agree. The latest record is never skipped: when
 * its run did not succeed (failed, superseded, still running), the record is
 * not SHIP-complete and the review is full, rather than reaching back to an
 * older SHIP past newer evidence.
 */
import { constantTimeDigestEqual } from '../utils/constantTimeDigest';
import { priorReviewRecordFromRows, type PriorReviewRecord, type PriorReviewRows } from '../review/incrementalReview';

export interface Queryable { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }

const RUN_ID = /^run_[a-f0-9]{32}$/u;

/**
 * The stored rows of the prior review record, selected as described above. Shared
 * by `selectPriorReviewRecord` (REL-1084) and the verdict cache's source
 * selection (REL-1085), so both features always name the same record.
 */
export async function selectPriorReviewRows(queryable: Queryable, currentRunId: string): Promise<PriorReviewRows | null> {
  if (!RUN_ID.test(currentRunId)) return null;
  const current = (await queryable.query(
    'SELECT repository_id, pr_number, received_at, authoritative_gate_app_id FROM review_runs WHERE run_id = $1',
    [currentRunId],
  )).rows[0];
  if (!current || current.repository_id == null || current.received_at == null) return null;
  const row = (await queryable.query(
    `SELECT runs.run_id, runs.repository_id, runs.pr_number, runs.head_sha, runs.base_sha, runs.status,
            runs.authoritative_gate_app_id,
            completions.execution_attempt, completions.content_digest, completions.payload, completions.created_at,
            gate.worker_result_digest AS gate_worker_result_digest, gate.evidence AS gate_evidence,
            gate.decision AS gate_decision
       FROM review_worker_completions completions
       JOIN review_runs runs ON runs.run_id = completions.run_id
       LEFT JOIN LATERAL (
         SELECT attempts.worker_result_digest, attempts.evidence, attempts.decision
           FROM review_gate_attempts attempts
          WHERE attempts.run_id = completions.run_id
            AND attempts.worker_result_digest = completions.content_digest
          ORDER BY attempts.review_generation DESC
          LIMIT 1
       ) gate ON true
      WHERE runs.repository_id = $1 AND runs.pr_number = $2 AND runs.run_id <> $3
        AND completions.created_at < $4
      ORDER BY completions.created_at DESC, completions.execution_attempt DESC
      LIMIT 1`,
    [current.repository_id, current.pr_number, currentRunId, current.received_at],
  )).rows[0];
  if (!row) return null;
  // REL-1084/REL-1085: the gate's own record of this exact completion, from which the prior's
  // verdict is derived (`priorReviewRecordFromRows`). Null for a record no gate decided.
  const gate = row.gate_worker_result_digest == null ? null
    : { worker_result_digest: row.gate_worker_result_digest, evidence: row.gate_evidence, decision: row.gate_decision };
  return { run: row, completion: row, gate, currentReceivedAt: current.received_at,
    currentAuthoritativeGateAppId: current.authoritative_gate_app_id ?? null };
}

export async function selectPriorReviewRecord(queryable: Queryable, currentRunId: string): Promise<PriorReviewRecord | null> {
  const rows = await selectPriorReviewRows(queryable, currentRunId);
  return rows ? priorReviewRecordFromRows(rows) : null;
}

/**
 * True only for the exact live execution the bearer was minted for: the run is
 * queued or running and the token digest matches that attempt's dispatch record.
 * Shared by every worker planning read (REL-1084, REL-1085).
 */
export async function workerExecutionAuthorized(queryable: Queryable,
  input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<boolean> {
  if (!RUN_ID.test(input.runId) || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 1) return false;
  const binding = (await queryable.query(
    `SELECT runs.status, outbox.worker_token_digest
       FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1 AND outbox.execution_attempt + 1 = $2`,
    [input.runId, input.executionAttempt],
  )).rows[0];
  return Boolean(binding) && constantTimeDigestEqual(binding.worker_token_digest, input.workerTokenDigest)
    && ['queued', 'running'].includes(String(binding.status));
}

export type IncrementalBaseLookupResult =
  | { status: 'unauthorized' }
  | { status: 'ok'; prior: PriorReviewRecord | null; maxAgeMs: number };

/** The worker planning endpoint's store: authenticates the exact execution, then selects. */
export interface IncrementalBaseLookup {
  read(input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<IncrementalBaseLookupResult>;
}

export class PostgresIncrementalBaseLookup implements IncrementalBaseLookup {
  constructor(private readonly queryable: Queryable, private readonly options: { maxAgeMs: number }) {
    if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs <= 0) throw new Error('Incremental max age must be positive');
  }

  /** The configured age limit the worker is told, the same value trusted verification uses. */
  get maxAgeMs(): number { return this.options.maxAgeMs; }

  async read(input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<IncrementalBaseLookupResult> {
    if (!await workerExecutionAuthorized(this.queryable, input)) return { status: 'unauthorized' };
    return { status: 'ok', prior: await selectPriorReviewRecord(this.queryable, input.runId), maxAgeMs: this.options.maxAgeMs };
  }
}
