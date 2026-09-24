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
import { priorReviewRecordFromRows, type PriorReviewRecord } from '../review/incrementalReview';

interface Queryable { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }

const RUN_ID = /^run_[a-f0-9]{32}$/u;

export async function selectPriorReviewRecord(queryable: Queryable, currentRunId: string): Promise<PriorReviewRecord | null> {
  if (!RUN_ID.test(currentRunId)) return null;
  const current = (await queryable.query(
    'SELECT repository_id, pr_number, received_at FROM review_runs WHERE run_id = $1',
    [currentRunId],
  )).rows[0];
  if (!current || current.repository_id == null || current.received_at == null) return null;
  const row = (await queryable.query(
    `SELECT runs.run_id, runs.repository_id, runs.pr_number, runs.head_sha, runs.base_sha, runs.status,
            completions.execution_attempt, completions.content_digest, completions.payload, completions.created_at
       FROM review_worker_completions completions
       JOIN review_runs runs ON runs.run_id = completions.run_id
      WHERE runs.repository_id = $1 AND runs.pr_number = $2 AND runs.run_id <> $3
        AND completions.created_at < $4
      ORDER BY completions.created_at DESC, completions.execution_attempt DESC
      LIMIT 1`,
    [current.repository_id, current.pr_number, currentRunId, current.received_at],
  )).rows[0];
  if (!row) return null;
  return priorReviewRecordFromRows({
    run: row,
    completion: row,
    currentReceivedAt: current.received_at,
  });
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
    if (!RUN_ID.test(input.runId) || !Number.isSafeInteger(input.executionAttempt) || input.executionAttempt < 1) {
      return { status: 'unauthorized' };
    }
    const binding = (await this.queryable.query(
      `SELECT runs.status, outbox.worker_token_digest
         FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
        WHERE runs.run_id = $1 AND outbox.execution_attempt + 1 = $2`,
      [input.runId, input.executionAttempt],
    )).rows[0];
    if (!binding || !constantTimeDigestEqual(binding.worker_token_digest, input.workerTokenDigest)
      || !['queued', 'running'].includes(String(binding.status))) return { status: 'unauthorized' };
    return { status: 'ok', prior: await selectPriorReviewRecord(this.queryable, input.runId), maxAgeMs: this.options.maxAgeMs };
  }
}
