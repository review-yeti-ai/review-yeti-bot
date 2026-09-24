/**
 * REL-1085: the service's one selection of the stored record a verdict-cache
 * hit may rest on. It is the same record W7 carries forward from
 * (`selectPriorReviewRows`): the pull request's latest completion stored before
 * this run was admitted, in the same repository. Cache entries live inside that
 * existing `review_worker_completions` row; there is no separate cache table.
 *
 * Both the worker's planning endpoint and the trusted completion side call
 * `selectVerdictCacheSource`, so they name the same record, and neither accepts
 * a record the worker supplied.
 */
import { selectPriorReviewRows, workerExecutionAuthorized, type Queryable } from './incrementalPriorReview';
import { verdictCacheSourceFromRows, type VerdictCacheSource } from '../review/verdictCache';

export async function selectVerdictCacheSource(queryable: Queryable, currentRunId: string): Promise<VerdictCacheSource | null> {
  const rows = await selectPriorReviewRows(queryable, currentRunId);
  return rows ? verdictCacheSourceFromRows(rows) : null;
}

export type VerdictCacheBaseLookupResult =
  | { status: 'unauthorized' }
  | { status: 'ok'; source: VerdictCacheSource | null; maxAgeMs: number };

/** The worker planning endpoint's store: authenticates the exact execution, then selects. */
export interface VerdictCacheBaseLookup {
  read(input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<VerdictCacheBaseLookupResult>;
}

export class PostgresVerdictCacheBaseLookup implements VerdictCacheBaseLookup {
  constructor(private readonly queryable: Queryable, private readonly options: { maxAgeMs: number }) {
    if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs <= 0) throw new Error('Verdict cache max age must be positive');
  }

  /** The configured age limit the worker is told, the same value trusted verification uses. */
  get maxAgeMs(): number { return this.options.maxAgeMs; }

  async read(input: { runId: string; executionAttempt: number; workerTokenDigest: string }): Promise<VerdictCacheBaseLookupResult> {
    if (!await workerExecutionAuthorized(this.queryable, input)) return { status: 'unauthorized' };
    return { status: 'ok', source: await selectVerdictCacheSource(this.queryable, input.runId), maxAgeMs: this.options.maxAgeMs };
  }
}
