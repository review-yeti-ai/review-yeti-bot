export interface MergeGroupGateState {
  checkId: number;
  conclusion: 'success' | 'failure';
  snapshotDigest: string;
}

export interface MergeGroupGatePriorPublication {
  snapshotDigest: string;
  checkId: number | null;
  checkCreationStarted: boolean;
  conclusion: 'success' | 'failure' | null;
}

export type MergeGroupGateClaim =
  | { status: 'acquired' }
  | { status: 'busy' };

interface QueryResult { rows: any[]; }
interface TransactionClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}
interface ConnectionPool { connect(): Promise<TransactionClient>; }

const UNRESOLVED_PRIOR_PUBLICATION = "check_creation_started=TRUE AND conclusion IS DISTINCT FROM 'failure'";

export interface MergeGroupGateRepository {
  claim(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<MergeGroupGateClaim>;
  /** Persist a committed create intent. Only the first owner may POST; retries only reconcile. */
  reserveCheckCreation(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<boolean>;
  /** Bind the one exact App check discovered or created for this durable snapshot. */
  bindCheck(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string, checkId: number): Promise<void>;
  /** List earlier same-head create intents that must be reconciled before a newer snapshot can publish. */
  listPriorPublications(repositoryId: number, headSha: string, snapshotDigest: string,
    claimToken: string): Promise<MergeGroupGatePriorPublication[]>;
  /** Bind and retire a prior snapshot after its exact GitHub check was safely invalidated. */
  settlePriorPublication(repositoryId: number, headSha: string, snapshotDigest: string,
    claimToken: string, priorSnapshotDigest: string, checkId: number): Promise<void>;
  complete(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string, result: MergeGroupGateState): Promise<void>;
  release(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<void>;
}

function validateIdentity(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): void {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !/^[a-f0-9]{40}$/u.test(headSha)
    || !/^[a-f0-9]{64}$/u.test(snapshotDigest)
    || !/^[0-9a-f-]{36}$/u.test(claimToken)) throw new Error('Merge-group gate identity is invalid');
}

/** Uses short transactions to claim and persist a gate without holding a pool
 * connection while GitHub is queried. The durable lease serializes replicas;
 * exact external-id reconciliation resumes a check after an expired lease. */
export class PostgresMergeGroupGateRepository implements MergeGroupGateRepository {
  constructor(private readonly pool: ConnectionPool) {}

  async claim(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<MergeGroupGateClaim> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const selected = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM merge_group_gate_publications
            WHERE repository_id = $1 AND head_sha = $2
              AND claim_token IS NOT NULL AND lease_expires_at > CURRENT_TIMESTAMP
         ) AS lease_active`, [repositoryId, headSha]);
      if (selected.rows[0]?.lease_active === true) {
        await client.query('COMMIT');
        return { status: 'busy' };
      }
      await client.query(
        `INSERT INTO merge_group_gate_publications
           (repository_id, head_sha, snapshot_digest, check_id, conclusion, check_creation_started,
            claim_token, lease_expires_at, updated_at)
         VALUES ($1, $2, $3, NULL, NULL, FALSE, $4, CURRENT_TIMESTAMP + INTERVAL '10 minutes', CURRENT_TIMESTAMP)
         ON CONFLICT (repository_id, head_sha, snapshot_digest) DO UPDATE
           SET conclusion = NULL,
               claim_token = EXCLUDED.claim_token,
               lease_expires_at = EXCLUDED.lease_expires_at,
               updated_at = CURRENT_TIMESTAMP`, [repositoryId, headSha, snapshotDigest, claimToken]);
      await client.query('COMMIT');
      return { status: 'acquired' };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async reserveCheckCreation(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<boolean> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const selected = await client.query(`SELECT check_id,check_creation_started FROM merge_group_gate_publications
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3 AND claim_token=$4
          AND lease_expires_at > CURRENT_TIMESTAMP FOR UPDATE`, [repositoryId, headSha, snapshotDigest, claimToken]);
      const row = selected.rows[0];
      if (!row) throw new Error('Merge-group gate claim is no longer owned');
      if (row.check_id !== null && row.check_id !== undefined) {
        await client.query('COMMIT');
        return false;
      }
      if (row.check_creation_started === true) {
        await client.query('COMMIT');
        return false;
      }
      const older = await client.query(`SELECT 1 FROM merge_group_gate_publications
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest<>$3
          AND ${UNRESOLVED_PRIOR_PUBLICATION} LIMIT 1`,
      [repositoryId, headSha, snapshotDigest]);
      if (older.rows.length > 0) {
        await client.query('COMMIT');
        return false;
      }
      const updated = await client.query(`UPDATE merge_group_gate_publications SET check_creation_started=TRUE,updated_at=CURRENT_TIMESTAMP
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3 AND claim_token=$4
          AND check_id IS NULL AND check_creation_started=FALSE RETURNING repository_id`,
      [repositoryId, headSha, snapshotDigest, claimToken]);
      if (updated.rows.length !== 1) throw new Error('Merge-group check creation reservation was lost');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async bindCheck(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string, checkId: number): Promise<void> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    if (!Number.isSafeInteger(checkId) || checkId <= 0) throw new Error('Merge-group check id is invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const updated = await client.query(`UPDATE merge_group_gate_publications SET check_id=$5,check_creation_started=TRUE,
          updated_at=CURRENT_TIMESTAMP
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3 AND claim_token=$4
          AND lease_expires_at > CURRENT_TIMESTAMP AND (check_id IS NULL OR check_id=$5)
        RETURNING check_id`, [repositoryId, headSha, snapshotDigest, claimToken, checkId]);
      if (updated.rows.length !== 1) throw new Error('Merge-group check identity could not be durably bound');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async listPriorPublications(repositoryId: number, headSha: string, snapshotDigest: string,
    claimToken: string): Promise<MergeGroupGatePriorPublication[]> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const current = await client.query(`SELECT 1 FROM merge_group_gate_publications
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3 AND claim_token=$4
          AND lease_expires_at > CURRENT_TIMESTAMP`, [repositoryId, headSha, snapshotDigest, claimToken]);
      if (current.rows.length !== 1) throw new Error('Merge-group gate claim is no longer owned');
      const selected = await client.query(`SELECT snapshot_digest,check_id,check_creation_started,conclusion
        FROM merge_group_gate_publications WHERE repository_id=$1 AND head_sha=$2
          AND snapshot_digest<>$3 AND ${UNRESOLVED_PRIOR_PUBLICATION}
        ORDER BY created_at,snapshot_digest`, [repositoryId, headSha, snapshotDigest]);
      await client.query('COMMIT');
      return selected.rows.map((row) => ({ snapshotDigest: String(row.snapshot_digest).trim(),
        checkId: row.check_id === null || row.check_id === undefined ? null : Number(row.check_id),
        checkCreationStarted: row.check_creation_started === true,
        conclusion: row.conclusion === 'success' || row.conclusion === 'failure' ? row.conclusion : null }));
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async settlePriorPublication(repositoryId: number, headSha: string, snapshotDigest: string,
    claimToken: string, priorSnapshotDigest: string, checkId: number): Promise<void> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    if (!/^[a-f0-9]{64}$/u.test(priorSnapshotDigest) || priorSnapshotDigest === snapshotDigest
      || !Number.isSafeInteger(checkId) || checkId <= 0) throw new Error('Prior merge-group publication identity is invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const current = await client.query(`SELECT 1 FROM merge_group_gate_publications
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3 AND claim_token=$4
          AND lease_expires_at > CURRENT_TIMESTAMP`, [repositoryId, headSha, snapshotDigest, claimToken]);
      if (current.rows.length !== 1) throw new Error('Merge-group gate claim is no longer owned');
      const updated = await client.query(`UPDATE merge_group_gate_publications
        SET check_id=$4,check_creation_started=TRUE,conclusion='failure',claim_token=NULL,
            lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE repository_id=$1 AND head_sha=$2 AND snapshot_digest=$3
          AND ${UNRESOLVED_PRIOR_PUBLICATION}
          AND (check_id IS NULL OR check_id=$4) RETURNING check_id`,
      [repositoryId, headSha, priorSnapshotDigest, checkId]);
      if (updated.rows.length !== 1) throw new Error('Prior merge-group publication could not be settled');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async complete(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string, result: MergeGroupGateState): Promise<void> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    if (!Number.isSafeInteger(result.checkId) || result.checkId <= 0
      || (result.conclusion !== 'success' && result.conclusion !== 'failure')
      || result.snapshotDigest !== snapshotDigest) {
      throw new Error('Merge-group gate result is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-merge-group:${repositoryId}:${headSha}`]);
      const updated = await client.query(
        `UPDATE merge_group_gate_publications
            SET check_id = $5, check_creation_started=TRUE, conclusion = $6, claim_token = NULL,
                lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE repository_id = $1 AND head_sha = $2 AND snapshot_digest = $3 AND claim_token = $4
            AND conclusion IS NULL AND (check_id IS NULL OR check_id = $5)
        RETURNING check_id`, [repositoryId, headSha, snapshotDigest, claimToken, result.checkId, result.conclusion]);
      if (updated.rows.length !== 1) throw new Error('Merge-group gate claim is no longer owned');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    } finally { client.release(); }
  }

  async release(repositoryId: number, headSha: string, snapshotDigest: string, claimToken: string): Promise<void> {
    validateIdentity(repositoryId, headSha, snapshotDigest, claimToken);
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE merge_group_gate_publications SET claim_token=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP
          WHERE repository_id = $1 AND head_sha = $2 AND snapshot_digest = $3 AND claim_token = $4
            AND conclusion IS NULL`, [repositoryId, headSha, snapshotDigest, claimToken]);
    } finally { client.release(); }
  }
}
