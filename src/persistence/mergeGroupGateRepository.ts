export interface MergeGroupGateState {
  checkId: number;
  conclusion: 'success' | 'failure';
}

export type MergeGroupGateClaim =
  | { status: 'acquired' }
  | { status: 'busy' }
  | { status: 'terminal'; result: MergeGroupGateState };

interface QueryResult { rows: any[]; }
interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface ConnectionPool { connect(): Promise<TransactionClient>; }

export interface MergeGroupGateRepository {
  claim(repositoryId: number, headSha: string, claimToken: string): Promise<MergeGroupGateClaim>;
  complete(repositoryId: number, headSha: string, claimToken: string, result: MergeGroupGateState): Promise<void>;
  release(repositoryId: number, headSha: string, claimToken: string): Promise<void>;
}

function validateIdentity(repositoryId: number, headSha: string, claimToken: string): void {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !/^[a-f0-9]{40}$/u.test(headSha)
    || !/^[0-9a-f-]{36}$/u.test(claimToken)) throw new Error('Merge-group gate identity is invalid');
}

/** Uses short transactions to claim and persist a gate without holding a pool
 * connection while GitHub is queried. The durable lease serializes replicas;
 * exact external-id reconciliation resumes a check after an expired lease. */
export class PostgresMergeGroupGateRepository implements MergeGroupGateRepository {
  constructor(private readonly pool: ConnectionPool) {}

  async claim(repositoryId: number, headSha: string, claimToken: string): Promise<MergeGroupGateClaim> {
    validateIdentity(repositoryId, headSha, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const selected = await client.query(
        `SELECT check_id, conclusion,
                claim_token IS NOT NULL AND lease_expires_at > CURRENT_TIMESTAMP AS lease_active
           FROM merge_group_gates
          WHERE repository_id = $1 AND head_sha = $2`, [repositoryId, headSha]);
      const row = selected.rows[0];
      if (row?.check_id && (row.conclusion === 'success' || row.conclusion === 'failure')) {
        await client.query('COMMIT');
        return { status: 'terminal', result: { checkId: Number(row.check_id), conclusion: row.conclusion } };
      }
      if (row?.lease_active === true) {
        await client.query('COMMIT');
        return { status: 'busy' };
      }
      await client.query(
        `INSERT INTO merge_group_gates
           (repository_id, head_sha, claim_token, lease_expires_at, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP)
         ON CONFLICT (repository_id, head_sha) DO UPDATE
           SET claim_token = EXCLUDED.claim_token,
               lease_expires_at = EXCLUDED.lease_expires_at,
               updated_at = CURRENT_TIMESTAMP`, [repositoryId, headSha, claimToken]);
      await client.query('COMMIT');
      return { status: 'acquired' };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async complete(repositoryId: number, headSha: string, claimToken: string, result: MergeGroupGateState): Promise<void> {
    validateIdentity(repositoryId, headSha, claimToken);
    if (!Number.isSafeInteger(result.checkId) || result.checkId <= 0
      || (result.conclusion !== 'success' && result.conclusion !== 'failure')) {
      throw new Error('Merge-group gate result is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const updated = await client.query(
        `UPDATE merge_group_gates
            SET check_id = $4, conclusion = $5, claim_token = NULL,
                lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE repository_id = $1 AND head_sha = $2 AND claim_token = $3
            AND conclusion IS NULL
        RETURNING check_id`, [repositoryId, headSha, claimToken, result.checkId, result.conclusion]);
      if (updated.rows.length !== 1) throw new Error('Merge-group gate claim is no longer owned');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async release(repositoryId: number, headSha: string, claimToken: string): Promise<void> {
    validateIdentity(repositoryId, headSha, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query(
        `DELETE FROM merge_group_gates
          WHERE repository_id = $1 AND head_sha = $2 AND claim_token = $3
            AND conclusion IS NULL`, [repositoryId, headSha, claimToken]);
    } finally { client.release(); }
  }
}
