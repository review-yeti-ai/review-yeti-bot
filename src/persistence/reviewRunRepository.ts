import { sha256 } from '../review/reviewCore';
import { assertStageTransition, PiStage } from '../review/piWorkflow';

export type ReviewRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';

export interface ReviewRunIdentity {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  snapshotDigest: string;
  configDigest: string;
}

export interface ReviewRunRecord {
  runId: string;
  identity: ReviewRunIdentity;
  identityDigest: string;
  status: ReviewRunStatus;
  stage: PiStage;
  attempt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  resultDigest?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewRunRepository {
  createOrGet(input: { identity: ReviewRunIdentity; now?: number }): Promise<ReviewRunRecord>;
  get(runId: string): Promise<ReviewRunRecord | null>;
  claim(runId: string, workerId: string, now: number, leaseMs: number): Promise<ReviewRunRecord | null>;
  heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean>;
  transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord>;
  succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord>;
  fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord>;
}

function clone(record: ReviewRunRecord): ReviewRunRecord {
  return JSON.parse(JSON.stringify(record));
}

function isTerminal(status: ReviewRunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'superseded';
}

export class InMemoryReviewRunRepository implements ReviewRunRepository {
  private readonly records = new Map<string, ReviewRunRecord>();
  private readonly identityIndex = new Map<string, string>();

  async createOrGet(input: { identity: ReviewRunIdentity; now?: number }): Promise<ReviewRunRecord> {
    const identityDigest = sha256(input.identity);
    const existingId = this.identityIndex.get(identityDigest);
    if (existingId) return clone(this.records.get(existingId)!);
    const now = input.now ?? Date.now();
    const record: ReviewRunRecord = {
      runId: `run_${identityDigest.slice(0, 32)}`,
      identity: { ...input.identity },
      identityDigest,
      status: 'queued',
      stage: 'admission',
      attempt: 0,
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

  async claim(runId: string, workerId: string, now: number, leaseMs: number): Promise<ReviewRunRecord | null> {
    const record = this.records.get(runId);
    if (!record || isTerminal(record.status)) return null;
    if (record.leaseOwner && record.leaseOwner !== workerId && (record.leaseExpiresAt || 0) > now) return null;
    record.status = 'running';
    record.attempt += 1;
    record.leaseOwner = workerId;
    record.leaseExpiresAt = now + leaseMs;
    record.updatedAt = now;
    return clone(record);
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const record = this.records.get(runId);
    if (!record || record.leaseOwner !== workerId || isTerminal(record.status)) return false;
    if ((record.leaseExpiresAt || 0) <= now) return false;
    record.leaseExpiresAt = now + leaseMs;
    record.updatedAt = now;
    return true;
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
    assertStageTransition(record.stage, nextStage);
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
    record.status = 'succeeded';
    record.stage = 'complete';
    record.resultDigest = resultDigest;
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
    record.leaseExpiresAt = undefined;
    record.updatedAt = now;
    return clone(record);
  }
}

export class PostgresReviewRunRepository implements ReviewRunRepository {
  constructor(private readonly db: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }) {}

  async createOrGet(input: { identity: ReviewRunIdentity; now?: number }): Promise<ReviewRunRecord> {
    const identityDigest = sha256(input.identity);
    const runId = `run_${identityDigest.slice(0, 32)}`;
    const now = new Date(input.now ?? Date.now()).toISOString();
    const result = await this.db.query(
      `INSERT INTO review_runs (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha, snapshot_digest, config_digest, identity, status, stage, attempt, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued','admission',0,$11,$11)
       ON CONFLICT (identity_digest) DO UPDATE SET updated_at = review_runs.updated_at
       RETURNING *`,
      [runId, identityDigest, input.identity.owner, input.identity.repo, input.identity.prNumber, input.identity.headSha, input.identity.baseSha, input.identity.snapshotDigest, input.identity.configDigest, JSON.stringify(input.identity), now],
    );
    return this.fromRow(result.rows[0]);
  }

  async get(runId: string): Promise<ReviewRunRecord | null> {
    const result = await this.db.query('SELECT * FROM review_runs WHERE run_id = $1', [runId]);
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async claim(runId: string, workerId: string, now: number, leaseMs: number): Promise<ReviewRunRecord | null> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='running', attempt=attempt+1, lease_owner=$2, lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND status IN ('queued','running') AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at <= to_timestamp($3 / 1000.0)) RETURNING *`,
      [runId, workerId, now + leaseMs],
    );
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE review_runs SET lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$2 AND status='running' AND lease_expires_at > to_timestamp($4 / 1000.0)`,
      [runId, workerId, now + leaseMs, now],
    );
    return (result as any).rowCount > 0;
  }

  async transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord> {
    const current = await this.get(runId);
    if (!current) throw new Error(`review run ${runId} not found`);
    assertStageTransition(current.stage, nextStage);
    const result = await this.db.query(
      `UPDATE review_runs SET stage=$2, result_digest=COALESCE($3,result_digest), updated_at=to_timestamp($4 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$5 AND status='running' AND lease_expires_at > to_timestamp($4 / 1000.0) RETURNING *`,
      [runId, nextStage, resultDigest || null, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} lease is not active`);
    return this.fromRow(result.rows[0]);
  }

  async succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='succeeded', stage='complete', result_digest=$2, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$4 AND stage='publish' AND status='running' RETURNING *`,
      [runId, resultDigest, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot succeed`);
    return this.fromRow(result.rows[0]);
  }

  async fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const result = await this.db.query(
      `UPDATE review_runs SET status='failed', error_text=$2, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
       WHERE run_id=$1 AND lease_owner=$4 AND status='running' RETURNING *`,
      [runId, error, now, workerId],
    );
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot fail`);
    return this.fromRow(result.rows[0]);
  }

  private fromRow(row: any): ReviewRunRecord {
    return {
      runId: row.run_id,
      identity: typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity,
      identityDigest: row.identity_digest,
      status: row.status,
      stage: row.stage,
      attempt: Number(row.attempt),
      leaseOwner: row.lease_owner || undefined,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : undefined,
      resultDigest: row.result_digest || undefined,
      error: row.error_text || undefined,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }
}
