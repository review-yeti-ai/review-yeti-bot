export interface MergeGroupGateState {
  checkId: number;
  conclusion: 'success' | 'failure';
}

interface QueryResult { rows: any[]; }
interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface ConnectionPool { connect(): Promise<TransactionClient>; }

export interface MergeGroupGateRepository {
  runExclusive<T extends MergeGroupGateState>(
    repositoryId: number,
    headSha: string,
    operation: (existing?: MergeGroupGateState) => Promise<T>,
  ): Promise<T>;
}

/** Serializes one synthetic merge-group check across replicas and retries. */
export class PostgresMergeGroupGateRepository implements MergeGroupGateRepository {
  constructor(private readonly pool: ConnectionPool) {}

  async runExclusive<T extends MergeGroupGateState>(repositoryId: number, headSha: string,
    operation: (existing?: MergeGroupGateState) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !/^[a-f0-9]{40}$/u.test(headSha)) {
      throw new Error('Merge-group gate identity is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const selected = await client.query(
        `SELECT check_id, conclusion FROM merge_group_gates
          WHERE repository_id = $1 AND head_sha = $2`, [repositoryId, headSha]);
      const row = selected.rows[0];
      const existing = row?.check_id && (row.conclusion === 'success' || row.conclusion === 'failure')
        ? { checkId: Number(row.check_id), conclusion: row.conclusion as 'success' | 'failure' }
        : undefined;
      const result = await operation(existing);
      if (!Number.isSafeInteger(result.checkId) || result.checkId <= 0
        || (result.conclusion !== 'success' && result.conclusion !== 'failure')) {
        throw new Error('Merge-group gate result is invalid');
      }
      await client.query(
        `INSERT INTO merge_group_gates (repository_id, head_sha, check_id, conclusion, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (repository_id, head_sha) DO UPDATE
           SET check_id = EXCLUDED.check_id, conclusion = EXCLUDED.conclusion, updated_at = CURRENT_TIMESTAMP`,
        [repositoryId, headSha, result.checkId, result.conclusion]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }
}
