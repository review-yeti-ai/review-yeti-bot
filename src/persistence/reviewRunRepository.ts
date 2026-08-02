import { sha256 } from '../review/reviewCore';
import { assertStageTransition, PiStage } from '../review/piWorkflow';
import { ReviewRun, ReviewRunIdentity, ReviewRunStatus } from '../review/reviewRun';

export type { ReviewRunIdentity, ReviewRunStatus } from '../review/reviewRun';
export type ReviewRunRecord = ReviewRun;

export interface ReviewRunRepository {
  createOrGet(input: { identity: ReviewRunIdentity; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord>;
  get(runId: string): Promise<ReviewRunRecord | null>;
  claim(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts?: number): Promise<ReviewRunRecord | null>;
  claimPublication(runId: string, workerId: string, now: number): Promise<ReviewRunRecord | null>;
  heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean>;
  recordArtifact(runId: string, stage: PiStage, digest: string, workerId: string, now: number): Promise<ReviewRunRecord>;
  transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord>;
  succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord>;
  fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord>;
  requeue(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord>;
  cancel(runId: string, now: number, error: string): Promise<ReviewRunRecord | null>;
  reapExpiredLeases(now: number): Promise<number>;
}

function clone(record: ReviewRunRecord): ReviewRunRecord {
  return JSON.parse(JSON.stringify(record));
}

function isTerminal(status: ReviewRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'superseded';
}

function publicationFenceFor(runId: string, workerId: string): string {
  return sha256({ runId, workerId });
}

export class InMemoryReviewRunRepository implements ReviewRunRepository {
  private readonly records = new Map<string, ReviewRunRecord>();
  private readonly identityIndex = new Map<string, string>();

  async createOrGet(input: { identity: ReviewRunIdentity; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord> {
    const identityDigest = sha256(input.identity);
    const existingId = this.identityIndex.get(identityDigest);
    if (existingId) return clone(this.records.get(existingId)!);
    const now = input.now ?? Date.now();
    for (const existing of this.records.values()) {
      const samePullRequest = existing.identity.owner === input.identity.owner && existing.identity.repo === input.identity.repo && existing.identity.prNumber === input.identity.prNumber;
      if (samePullRequest && existing.identity.headSha !== input.identity.headSha && (existing.status === 'queued' || existing.status === 'running')) {
        existing.status = 'superseded';
        existing.error = 'superseded by a newer pull request head';
        existing.leaseOwner = undefined;
        existing.leaseExpiresAt = undefined;
        existing.updatedAt = now;
      }
    }
    const record: ReviewRunRecord = {
      runId: `run_${identityDigest.slice(0, 32)}`,
      identity: { ...input.identity },
      identityDigest,
      effectivePolicyDigest: input.effectivePolicyDigest || input.identity.configDigest,
      effectiveConfigDigest: input.identity.configDigest,
      indexEpoch: input.indexEpoch ?? 0,
      status: 'queued',
      stage: 'admission',
      attempt: 0,
      artifacts: {},
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.runId, record);
    this.identityIndex.set(identityDigest, record.runId);
    return clone(record);
  }

  async get(runId: string): Promise<ReviewRunRecord | null> {
    const record = this.records.get(runId);
    return record ? clone(record) : null;
  }

  async claim(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts = 3): Promise<ReviewRunRecord | null> {
    const record = this.records.get(runId);
    if (!record || (record.status !== 'queued' && record.status !== 'running' && record.status !== 'failed')) return null;
    if (record.status === 'failed' && record.stage === 'publish') return null;
    if (record.attempt >= maxAttempts && !(record.leaseOwner === workerId && (record.leaseExpiresAt || 0) > now)) return null;
    if (record.leaseOwner && record.leaseOwner !== workerId && (record.leaseExpiresAt || 0) > now) return null;
    if (record.leaseOwner === workerId && (record.leaseExpiresAt || 0) > now) {
      record.leaseExpiresAt = now + leaseMs;
      record.updatedAt = now;
      return clone(record);
    }
    record.status = 'running';
    record.attempt += 1;
    record.error = undefined;
    record.leaseOwner = workerId;
    record.leaseExpiresAt = now + leaseMs;
    record.updatedAt = now;
    return clone(record);
  }

  async claimPublication(runId: string, workerId: string, now: number): Promise<ReviewRunRecord | null> {
    const record = this.records.get(runId);
    if (!record || record.stage !== 'publish' || record.leaseOwner !== workerId || (record.leaseExpiresAt || 0) <= now) return null;
    if (record.status === 'publishing') return clone(record);
    if (record.status !== 'running') return null;
    record.status = 'publishing';
    record.publicationFence = publicationFenceFor(runId, workerId);
    record.updatedAt = now;
    return clone(record);
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const record = this.records.get(runId);
    if (!record || record.leaseOwner !== workerId || (record.status !== 'running' && record.status !== 'publishing')) return false;
    if ((record.leaseExpiresAt || 0) <= now) return false;
    record.leaseExpiresAt = now + leaseMs;
    record.updatedAt = now;
    return true;
  }

  async recordArtifact(runId: string, stage: PiStage, digest: string, workerId: string, now: number): Promise<ReviewRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`review run ${runId} not found`);
    this.requireLease(record, workerId, now);
    if (record.stage !== stage) throw new Error(`review run ${runId} is not at ${stage}`);
    if (record.artifacts[stage] && record.artifacts[stage] !== digest) throw new Error(`review run ${runId} has a different ${stage} artifact`);
    record.artifacts[stage] = digest;
    record.updatedAt = now;
    return clone(record);
  }

  private requireLease(record: ReviewRunRecord, workerId: string, now: number): void {
    if (record.leaseOwner !== workerId || (record.leaseExpiresAt || 0) <= now) {
      throw new Error(`review run ${record.runId} is not leased by ${workerId}`);
    }
    if (isTerminal(record.status)) throw new Error(`review run ${record.runId} is already terminal`);
  }

  async transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`review run ${runId} not found`);
    this.requireLease(record, workerId, now);
    if (record.status !== 'running') throw new Error(`review run ${runId} cannot transition while ${record.status}`);
    assertStageTransition(record.stage, nextStage);
    if (!record.artifacts[record.stage]) throw new Error(`review run ${runId} cannot transition without a ${record.stage} artifact`);
    record.stage = nextStage;
    record.updatedAt = now;
    if (resultDigest) record.resultDigest = resultDigest;
    return clone(record);
  }

  async succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`review run ${runId} not found`);
    this.requireLease(record, workerId, now);
    if (record.stage !== 'publish') throw new Error(`review run ${runId} cannot succeed before publish`);
    if (record.artifacts.publish !== resultDigest) throw new Error(`review run ${runId} result digest does not match publish artifact`);
    if (record.status !== 'publishing' || !record.publicationFence) throw new Error(`review run ${runId} does not hold a publication claim`);
    record.status = 'succeeded';
    record.stage = 'complete';
    record.resultDigest = resultDigest;
    record.error = undefined;
    record.leaseOwner = undefined;
    record.leaseExpiresAt = undefined;
    record.updatedAt = now;
    return clone(record);
  }

  async fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`review run ${runId} not found`);
    this.requireLease(record, workerId, now);
    record.status = 'failed';
    record.error = error;
    record.leaseOwner = undefined;
    record.leaseExpiresAt = undefined;
    record.updatedAt = now;
    return clone(record);
  }

  async requeue(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`review run ${runId} not found`);
    this.requireLease(record, workerId, now);
    if (record.status !== 'running') throw new Error(`review run ${runId} cannot be requeued`);
    record.status = 'queued';
    record.error = error;
    record.leaseOwner = undefined;
    record.leaseExpiresAt = undefined;
    record.updatedAt = now;
    return clone(record);
  }

  async cancel(runId: string, now: number, error: string): Promise<ReviewRunRecord | null> {
    const record = this.records.get(runId);
    if (!record || (record.status !== 'queued' && record.status !== 'running')) return null;
    record.status = 'cancelled';
    record.error = error;
    record.leaseOwner = undefined;
    record.leaseExpiresAt = undefined;
    record.updatedAt = now;
    return clone(record);
  }

  async reapExpiredLeases(now: number): Promise<number> {
    let reaped = 0;
    for (const record of this.records.values()) {
      if ((record.status === 'running' || record.status === 'publishing') && (record.leaseExpiresAt || 0) <= now) {
        const wasPublishing = record.status === 'publishing';
        record.status = wasPublishing ? 'failed' : 'queued';
        record.error = wasPublishing ? 'publication lease expired after publication claim; outcome is unknown' : record.error;
        record.leaseOwner = undefined;
        record.leaseExpiresAt = undefined;
        record.updatedAt = now;
        reaped += 1;
      }
    }
    return reaped;
  }
}

export class PostgresReviewRunRepository implements ReviewRunRepository {
  constructor(private readonly db: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }) {}

  async createOrGet(input: { identity: ReviewRunIdentity; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord> {
    const identityDigest = sha256(input.identity);
    const runId = `run_${identityDigest.slice(0, 32)}`;
    const now = new Date(input.now ?? Date.now()).toISOString();
    const result = await this.db.query(
      `WITH superseded AS (
         UPDATE review_runs SET status='superseded', error_text='superseded by a newer pull request head', lease_owner=NULL, lease_expires_at=NULL, updated_at=$14
         WHERE owner=$3 AND repo=$4 AND pr_number=$5 AND head_sha <> $6 AND status IN ('queued','running')
       )
       INSERT INTO review_runs (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha, snapshot_digest, config_digest, effective_policy_digest, effective_config_digest, index_epoch, identity, status, stage, attempt, artifacts, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued','admission',0,'{}'::jsonb,$14,$14)
       ON CONFLICT (identity_digest) DO UPDATE SET updated_at = review_runs.updated_at
       RETURNING *`,
      [runId, identityDigest, input.identity.owner, input.identity.repo, input.identity.prNumber, input.identity.headSha, input.identity.baseSha, input.identity.snapshotDigest, input.identity.configDigest, input.effectivePolicyDigest || input.identity.configDigest, input.identity.configDigest, input.indexEpoch ?? 0, JSON.stringify(input.identity), now],
    );
    return this.fromRow(result.rows[0]);
  }

  async get(runId: string): Promise<ReviewRunRecord | null> {
    const result = await this.db.query('SELECT * FROM review_runs WHERE run_id = $1', [runId]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async claim(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts = 3): Promise<ReviewRunRecord | null> {
    const result = await this.db.query(
      `UPDATE review_runs SET status=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN status ELSE 'running' END, error_text=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN error_text ELSE NULL END, attempt=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN attempt ELSE attempt+1 END, lease_owner=$2, lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($4 / 1000.0)
       WHERE run_id=$1 AND status IN ('queued','running','failed') AND (status <> 'failed' OR stage <> 'publish') AND (attempt < $5 OR (lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0))) AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at <= to_timestamp($4 / 1000.0)) RETURNING *`,
      [runId, workerId, now + leaseMs, now, maxAttempts],
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async claimPublication(runId: string, workerId: string, now: number): Promise<ReviewRunRecord | null> {
    const publicationFence = publicationFenceFor(runId, workerId);
    const result = await this.db.query(
      `UPDATE review_runs SET status='publishing', publication_fence=COALESCE(publication_fence,$4), updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$2 AND stage='publish' AND status IN ('running','publishing')
       AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
      [runId, workerId, now, publicationFence],
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE review_runs SET lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($4 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$2 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($4 / 1000.0)
       RETURNING run_id`,
      [runId, workerId, now + leaseMs, now],
    );
    return result.rows.length > 0;
  }

  async recordArtifact(runId: string, stage: PiStage, digest: string, workerId: string, now: number): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET artifacts=jsonb_set(artifacts, ARRAY[$2], to_jsonb($3::text), true), updated_at=to_timestamp($4 / 1000.0)
       WHERE run_id=$1 AND stage=$2 AND lease_owner=$5 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($4 / 1000.0)
       AND (artifacts ->> $2 IS NULL OR artifacts ->> $2 = $3) RETURNING *`,
      [runId, stage, digest, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot record ${stage} artifact`);
    return this.fromRow(result.rows[0]);
  }

  async transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord> {
    const current = await this.get(runId);
    if (!current) throw new Error(`review run ${runId} not found`);
    assertStageTransition(current.stage, nextStage);
    const result = await this.db.query(
      `UPDATE review_runs SET stage=$2, result_digest=COALESCE($3,result_digest), updated_at=to_timestamp($4 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$5 AND status='running' AND stage=$6 AND artifacts ? $6::text
       AND lease_expires_at > to_timestamp($4 / 1000.0) RETURNING *`,
      [runId, nextStage, resultDigest || null, now, workerId, current.stage],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} lease is not active`);
    return this.fromRow(result.rows[0]);
  }

  async succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='succeeded', stage='complete', result_digest=$2, error_text=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$4 AND stage='publish' AND status='publishing' AND publication_fence IS NOT NULL AND artifacts ->> 'publish' = $2
       AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
      [runId, resultDigest, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot succeed`);
    return this.fromRow(result.rows[0]);
  }

  async fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='failed', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$4 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
      [runId, error, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot fail`);
    return this.fromRow(result.rows[0]);
  }

  async requeue(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='queued', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$4 AND status='running' AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
      [runId, error, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot be requeued`);
    return this.fromRow(result.rows[0]);
  }

  async cancel(runId: string, now: number, error: string): Promise<ReviewRunRecord | null> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='cancelled', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND status IN ('queued','running') RETURNING *`,
      [runId, error, now],
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async reapExpiredLeases(now: number): Promise<number> {
    const result = await this.db.query(
      `UPDATE review_runs SET status=CASE WHEN status='publishing' THEN 'failed' ELSE 'queued' END,
       error_text=CASE WHEN status='publishing' THEN 'publication lease expired after publication claim; outcome is unknown' ELSE error_text END,
       lease_owner=NULL, lease_expires_at=NULL,
       updated_at=to_timestamp($1 / 1000.0)
       WHERE status IN ('running','publishing') AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($1 / 1000.0)) RETURNING run_id`,
      [now],
    );
    return result.rows.length;
  }

  private fromRow(row: any): ReviewRunRecord {
    return {
      runId: row.run_id,
      identity: typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity,
      identityDigest: row.identity_digest,
      effectivePolicyDigest: row.effective_policy_digest || row.config_digest,
      effectiveConfigDigest: row.effective_config_digest || row.config_digest,
      indexEpoch: Number(row.index_epoch || 0),
      status: row.status,
      stage: row.stage,
      attempt: Number(row.attempt),
      artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : (row.artifacts || {}),
      leaseOwner: row.lease_owner || undefined,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : undefined,
      publicationFence: row.publication_fence || undefined,
      resultDigest: row.result_digest || undefined,
      error: row.error_text || undefined,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }
}
