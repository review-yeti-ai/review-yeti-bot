import { sha256 } from '../review/reviewCore';
import { deriveReviewRunId } from '../review/reviewAdmission';
import { assertStageTransition, PiStage } from '../review/piWorkflow';
import { ReviewRun, ReviewRunIdentity, ReviewRunStatus } from '../review/reviewRun';
import type { ReviewYetiLifecycleEventV1 } from '../events/reviewYetiEvent';
import {
  appendLifecycleEventForRun,
  requireLifecycleEventsMode,
  type ReviewEventQueryable,
  type ReviewLifecycleEventsOptions,
} from './reviewEventRepository';
import {
  assertReviewPrCoordinates,
  lockReviewPr,
  reviewPrLockKey,
  tryLockReviewPr,
  withReviewPrTransaction,
  type ReviewPrTransactionClient,
} from './reviewPrTransaction';

export type { ReviewRunIdentity, ReviewRunStatus } from '../review/reviewRun';
export type ReviewRunRecord = ReviewRun;

export interface ReviewRunRepository {
  createOrGet(input: { identity: ReviewRunIdentity; repositoryId?: number; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord>;
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

  async createOrGet(input: { identity: ReviewRunIdentity; repositoryId?: number; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord> {
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
      runId: deriveReviewRunId(input.identity),
      identity: { ...input.identity },
      identityDigest,
      effectivePolicyDigest: input.effectivePolicyDigest || input.identity.configDigest,
      effectiveConfigDigest: input.identity.configDigest,
      indexEpoch: input.indexEpoch ?? 0,
      repositoryId: input.repositoryId,
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

interface ReviewRunDatabase {
  query?: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
  connect?: () => Promise<ReviewPrTransactionClient>;
}

// Keep lease predicates and their parameter positions identical in both lifecycle modes.
// Transaction ownership, PR locks, and event appends remain in the adapter methods.
type ReviewRunMutation = [text: string, values: unknown[]];

function claimMutation(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts: number): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN status ELSE 'running' END, error_text=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN error_text ELSE NULL END, attempt=CASE WHEN lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0) THEN attempt ELSE attempt+1 END, lease_owner=$2, lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($4 / 1000.0)
     WHERE run_id=$1 AND status IN ('queued','running','failed') AND (status <> 'failed' OR stage <> 'publish') AND (attempt < $5 OR (lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0))) AND (lease_owner IS NULL OR lease_owner=$2 OR lease_expires_at <= to_timestamp($4 / 1000.0)) RETURNING *`,
    [runId, workerId, now + leaseMs, now, maxAttempts],
  ];
}

function claimPublicationMutation(runId: string, workerId: string, now: number): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status='publishing', publication_fence=COALESCE(publication_fence,$4), updated_at=to_timestamp($3 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$2 AND stage='publish' AND status IN ('running','publishing')
     AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
    [runId, workerId, now, publicationFenceFor(runId, workerId)],
  ];
}

function heartbeatMutation(runId: string, workerId: string, now: number, leaseMs: number): ReviewRunMutation {
  return [
    `UPDATE review_runs SET lease_expires_at=to_timestamp($3 / 1000.0), updated_at=to_timestamp($4 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$2 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($4 / 1000.0)
     RETURNING run_id`,
    [runId, workerId, now + leaseMs, now],
  ];
}

function recordArtifactMutation(runId: string, stage: PiStage, digest: string, workerId: string, now: number): ReviewRunMutation {
  return [
    `UPDATE review_runs SET artifacts=jsonb_set(artifacts, ARRAY[$2], to_jsonb($3::text), true), updated_at=to_timestamp($4 / 1000.0)
     WHERE run_id=$1 AND stage=$2 AND lease_owner=$5 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($4 / 1000.0)
     AND (artifacts ->> $2 IS NULL OR artifacts ->> $2 = $3) RETURNING *`,
    [runId, stage, digest, now, workerId],
  ];
}

function transitionMutation(runId: string, nextStage: PiStage, workerId: string, now: number, currentStage: PiStage, resultDigest?: string): ReviewRunMutation {
  return [
    `UPDATE review_runs SET stage=$2, result_digest=COALESCE($3,result_digest), updated_at=to_timestamp($4 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$5 AND status='running' AND stage=$6 AND artifacts ? $6::text
     AND lease_expires_at > to_timestamp($4 / 1000.0) RETURNING *`,
    [runId, nextStage, resultDigest || null, now, workerId, currentStage],
  ];
}

function succeedMutation(runId: string, workerId: string, now: number, resultDigest: string): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status='succeeded', stage='complete', result_digest=$2, error_text=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$4 AND stage='publish' AND status='publishing' AND publication_fence IS NOT NULL AND artifacts ->> 'publish' = $2
     AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
    [runId, resultDigest, now, workerId],
  ];
}

function failMutation(runId: string, workerId: string, now: number, error: string): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status='failed', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$4 AND status IN ('running','publishing') AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
    [runId, error, now, workerId],
  ];
}

function requeueMutation(runId: string, workerId: string, now: number, error: string): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status='queued', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
     WHERE run_id=$1 AND lease_owner=$4 AND status='running' AND lease_expires_at > to_timestamp($3 / 1000.0) RETURNING *`,
    [runId, error, now, workerId],
  ];
}

function cancelMutation(runId: string, now: number, error: string): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status='cancelled', error_text=$2, lease_owner=NULL, lease_expires_at=NULL, updated_at=to_timestamp($3 / 1000.0)
     WHERE run_id=$1 AND status IN ('queued','running') RETURNING *`,
    [runId, error, now],
  ];
}

function reapMutation(now: number, binding?: { runId: string; repositoryId: number; prNumber: number }): ReviewRunMutation {
  return [
    `UPDATE review_runs SET status=CASE WHEN status='publishing' THEN 'failed' ELSE 'queued' END,
     error_text=CASE WHEN status='publishing' THEN 'publication lease expired after publication claim; outcome is unknown' ELSE error_text END,
     lease_owner=NULL, lease_expires_at=NULL,
     updated_at=to_timestamp($1 / 1000.0)
     WHERE status IN ('running','publishing') AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($1 / 1000.0))
       ${binding ? 'AND run_id=$2 AND repository_id=$3 AND pr_number=$4' : ''}
     RETURNING run_id`,
    binding ? [now, binding.runId, binding.repositoryId, binding.prNumber] : [now],
  ];
}

const REAPER_BATCH_SIZE = 100;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const REVIEW_RUN_IDENTITY_KEYS = ['owner', 'repo', 'prNumber', 'headSha', 'baseSha', 'snapshotDigest', 'configDigest'] as const;

function isReviewRunIdentity(value: unknown): value is ReviewRunIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...REVIEW_RUN_IDENTITY_KEYS].sort().join('\0')) return false;
  return typeof record.owner === 'string'
    && typeof record.repo === 'string'
    && isPositiveSafeInteger(record.prNumber)
    && typeof record.headSha === 'string'
    && typeof record.baseSha === 'string'
    && typeof record.snapshotDigest === 'string'
    && typeof record.configDigest === 'string';
}

function sameReviewRunIdentity(left: ReviewRunIdentity, right: ReviewRunIdentity): boolean {
  return REVIEW_RUN_IDENTITY_KEYS.every(key => left[key] === right[key]);
}

export class PostgresReviewRunRepository implements ReviewRunRepository {
  private readonly lifecycleEventsEnabled: boolean;

  constructor(private readonly db: ReviewRunDatabase, options?: ReviewLifecycleEventsOptions) {
    this.lifecycleEventsEnabled = requireLifecycleEventsMode(
      options === undefined ? { lifecycleEvents: 'disabled' } : options,
      'PostgresReviewRunRepository',
    );
    if (this.lifecycleEventsEnabled && typeof this.db.connect !== 'function') {
      throw new Error('PostgresReviewRunRepository lifecycle events require a connection pool');
    }
  }

  async createOrGet(input: { identity: ReviewRunIdentity; repositoryId?: number; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.createOrGetDisabled(input);
    if (!isPositiveSafeInteger(input.repositoryId)) {
      throw new Error('repository id must be a positive safe integer for enabled lifecycle events');
    }

    const repositoryId = input.repositoryId;
    const coordinates = assertReviewPrCoordinates(repositoryId, input.identity.prNumber);
    const identityDigest = sha256(input.identity);
    const runId = deriveReviewRunId(input.identity);
    const now = input.now ?? Date.now();
    return this.withTransaction(async (client) => {
      await lockReviewPr(client, coordinates.repositoryId, coordinates.prNumber);

      const existing = (await client.query(
        'SELECT * FROM review_runs WHERE identity_digest = $1 FOR UPDATE',
        [identityDigest],
      )).rows[0];
      if (existing) {
        this.assertStoredRunIdentity(existing, input.identity);
        this.assertRepositoryBinding(existing, repositoryId, true);
        return this.fromRow(existing);
      }

      const inserted = await client.query(
        `INSERT INTO review_runs
          (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
           snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
           index_epoch, identity, repository_id, status, stage, attempt, artifacts,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           'queued', 'admission', 0, '{}'::jsonb, to_timestamp($15 / 1000.0),
           to_timestamp($15 / 1000.0))
         ON CONFLICT (identity_digest) DO NOTHING
         RETURNING *`,
        [
          runId, identityDigest, input.identity.owner, input.identity.repo, input.identity.prNumber,
          input.identity.headSha, input.identity.baseSha, input.identity.snapshotDigest,
          input.identity.configDigest, input.effectivePolicyDigest || input.identity.configDigest,
          input.identity.configDigest, input.indexEpoch ?? 0, JSON.stringify(input.identity),
          repositoryId, now,
        ],
      );
      if (inserted.rows[0]) {
        const candidates = (await client.query(
          `SELECT * FROM review_runs
            WHERE owner = $1 AND repo = $2 AND pr_number = $3 AND head_sha <> $4
              AND status IN ('queued', 'running')
            ORDER BY run_id
            FOR UPDATE`,
          [input.identity.owner, input.identity.repo, input.identity.prNumber, input.identity.headSha],
        )).rows;
        for (const candidate of candidates) {
          this.assertStoredRunIdentity(candidate);
          this.assertRepositoryBinding(candidate, repositoryId);
          const superseded = await client.query(
            `UPDATE review_runs
                SET status = 'superseded',
                    error_text = 'superseded by a newer pull request head',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = to_timestamp($2 / 1000.0)
              WHERE run_id = $1 AND status IN ('queued', 'running')
              RETURNING *`,
            [candidate.run_id, now],
          );
          if (superseded.rows[0]) {
            await this.append(client, String(candidate.run_id), 'review.lifecycle.superseded', now, {
              stage: 'superseded',
              terminal_class: 'candidate_superseded',
            });
          }
        }

        await this.append(client, runId, 'review.lifecycle.admission', now, { stage: 'admission' });
        await this.append(client, runId, 'review.lifecycle.queued', now, { stage: 'queued' });
        return this.fromRow(inserted.rows[0]);
      }

      const concurrent = (await client.query(
        'SELECT * FROM review_runs WHERE identity_digest = $1 FOR UPDATE',
        [identityDigest],
      )).rows[0];
      if (!concurrent) throw new Error(`review run ${runId} could not be created or recovered`);
      this.assertStoredRunIdentity(concurrent, input.identity);
      this.assertRepositoryBinding(concurrent, repositoryId, true);
      return this.fromRow(concurrent);
    });
  }

  async get(runId: string): Promise<ReviewRunRecord | null> {
    if (!this.lifecycleEventsEnabled) {
      const result = await this.query('SELECT * FROM review_runs WHERE run_id = $1', [runId]);
      return result.rows[0] ? this.fromRow(result.rows[0]) : null;
    }
    return this.withReadClient(async (client) => {
      const result = await client.query('SELECT * FROM review_runs WHERE run_id = $1', [runId]);
      return result.rows[0] ? this.fromRow(result.rows[0]) : null;
    });
  }

  async claim(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts = 3): Promise<ReviewRunRecord | null> {
    if (!this.lifecycleEventsEnabled) return this.claimDisabled(runId, workerId, now, leaseMs, maxAttempts);
    return this.withTransaction(async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) return null;
      const reentrant = current.lease_owner === workerId
        && current.lease_expires_at
        && new Date(current.lease_expires_at).getTime() > now;
      const result = await client.query(...claimMutation(runId, workerId, now, leaseMs, maxAttempts));
      if (!result.rows[0]) return null;
      if (!reentrant) await this.append(client, runId, 'review.lifecycle.started', now, { stage: 'started' });
      return this.fromRow(result.rows[0]);
    });
  }

  async claimPublication(runId: string, workerId: string, now: number): Promise<ReviewRunRecord | null> {
    if (!this.lifecycleEventsEnabled) return this.claimPublicationDisabled(runId, workerId, now);
    return this.withTransaction(async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) return null;
      const wasPublishing = current.status === 'publishing';
      const result = await client.query(...claimPublicationMutation(runId, workerId, now));
      if (!result.rows[0]) return null;
      if (!wasPublishing) {
        await this.append(client, runId, 'review.lifecycle.gate_publication', now, {
          stage: 'gate_publication',
          terminal_class: 'claimed',
        });
      }
      return this.fromRow(result.rows[0]);
    });
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    if (!this.lifecycleEventsEnabled) return this.heartbeatDisabled(runId, workerId, now, leaseMs);
    return this.withTransaction(async (client) => {
      if (!await this.lockRun(client, runId)) return false;
      const result = await client.query(...heartbeatMutation(runId, workerId, now, leaseMs));
      return result.rows.length > 0;
    });
  }

  async recordArtifact(runId: string, stage: PiStage, digest: string, workerId: string, now: number): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.recordArtifactDisabled(runId, stage, digest, workerId, now);
    return this.withTransaction(async (client) => {
      if (!await this.lockRun(client, runId)) throw new Error(`review run ${runId} not found`);
      const result = await client.query(...recordArtifactMutation(runId, stage, digest, workerId, now));
      if (!result.rows[0]) throw new Error(`review run ${runId} cannot record ${stage} artifact`);
      return this.fromRow(result.rows[0]);
    });
  }

  async transition(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.transitionDisabled(runId, nextStage, workerId, now, resultDigest);
    return this.withTransaction(async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) throw new Error(`review run ${runId} not found`);
      assertStageTransition(current.stage, nextStage);
      const result = await client.query(...transitionMutation(runId, nextStage, workerId, now, current.stage, resultDigest));
      if (!result.rows[0]) throw new Error(`review run ${runId} lease is not active`);
      await this.append(client, runId, 'review.lifecycle.started', now, { stage: nextStage });
      return this.fromRow(result.rows[0]);
    });
  }

  async succeed(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.succeedDisabled(runId, workerId, now, resultDigest);
    return this.withTransaction(async (client) => {
      if (!await this.lockRun(client, runId)) throw new Error(`review run ${runId} not found`);
      const result = await client.query(...succeedMutation(runId, workerId, now, resultDigest));
      if (!result.rows[0]) throw new Error(`review run ${runId} cannot succeed`);
      await this.append(client, runId, 'review.lifecycle.terminal', now, {
        stage: 'complete', terminal_class: 'success', result_digest: resultDigest,
      });
      return this.fromRow(result.rows[0]);
    });
  }

  async fail(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.failDisabled(runId, workerId, now, error);
    return this.withTransaction(async (client) => {
      if (!await this.lockRun(client, runId)) throw new Error(`review run ${runId} not found`);
      const result = await client.query(...failMutation(runId, workerId, now, error));
      if (!result.rows[0]) throw new Error(`review run ${runId} cannot fail`);
      await this.append(client, runId, 'review.lifecycle.terminal', now, {
        stage: 'terminal', terminal_class: 'failure',
      });
      return this.fromRow(result.rows[0]);
    });
  }

  async requeue(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    if (!this.lifecycleEventsEnabled) return this.requeueDisabled(runId, workerId, now, error);
    return this.withTransaction(async (client) => {
      const current = await this.lockRun(client, runId);
      if (!current) throw new Error(`review run ${runId} not found`);
      const result = await client.query(...requeueMutation(runId, workerId, now, error));
      if (!result.rows[0]) throw new Error(`review run ${runId} cannot be requeued`);
      await this.append(client, runId, 'review.lifecycle.retrying', now, {
        stage: current.stage, retry_class: 'requeue',
      });
      return this.fromRow(result.rows[0]);
    });
  }

  async cancel(runId: string, now: number, error: string): Promise<ReviewRunRecord | null> {
    if (!this.lifecycleEventsEnabled) return this.cancelDisabled(runId, now, error);
    return this.withTransaction(async (client) => {
      if (!await this.lockRun(client, runId)) return null;
      const result = await client.query(...cancelMutation(runId, now, error));
      if (!result.rows[0]) return null;
      await this.append(client, runId, 'review.lifecycle.terminal', now, {
        stage: 'terminal', terminal_class: 'cancelled',
      });
      return this.fromRow(result.rows[0]);
    });
  }

  async reapExpiredLeases(now: number): Promise<number> {
    if (!this.lifecycleEventsEnabled) {
      const result = await this.query(...reapMutation(now));
      return result.rows.length;
    }

    return this.withTransaction(async (client) => {
      const candidates = (await client.query(
        `SELECT run_id, repository_id, pr_number
           FROM review_runs
          WHERE status IN ('running', 'publishing')
            AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($1 / 1000.0))
            AND repository_id IS NOT NULL
          ORDER BY repository_id, pr_number, run_id
          LIMIT $2`,
        [now, REAPER_BATCH_SIZE],
      )).rows;
      let reaped = 0;
      let previousLockKey: string | undefined;
      let previousLockAvailable = false;
      for (const candidate of candidates) {
        const repositoryId = Number(candidate.repository_id);
        const prNumber = Number(candidate.pr_number);
        if (!isPositiveSafeInteger(repositoryId) || !isPositiveSafeInteger(prNumber)) {
          throw new Error(`Review lifecycle run metadata is incomplete for ${candidate.run_id}`);
        }
        const coordinates = assertReviewPrCoordinates(repositoryId, prNumber);
        const lockKey = reviewPrLockKey(coordinates.repositoryId, coordinates.prNumber);
        if (lockKey !== previousLockKey) {
          previousLockKey = lockKey;
          previousLockAvailable = await tryLockReviewPr(client, coordinates.repositoryId, coordinates.prNumber);
        }
        if (!previousLockAvailable) continue;
        const current = (await client.query(
          'SELECT * FROM review_runs WHERE run_id = $1 FOR UPDATE',
          [candidate.run_id],
        )).rows[0];
        if (!current) continue;
        this.assertStoredRunIdentity(current);
        this.assertRepositoryBinding(current, repositoryId);
        const publishing = current.status === 'publishing';
        const result = await client.query(...reapMutation(now, {
          runId: candidate.run_id, repositoryId, prNumber,
        }));
        if (!result.rows[0]) continue;
        reaped += 1;
        if (publishing) {
          await this.append(client, String(candidate.run_id), 'review.lifecycle.terminal', now, {
            stage: 'terminal', terminal_class: 'unknown', retry_class: 'lease_reaper',
          });
        } else {
          await this.append(client, String(candidate.run_id), 'review.lifecycle.retrying', now, {
            stage: current.stage, retry_class: 'lease_reaper',
          });
        }
      }
      return reaped;
    });
  }

  private async createOrGetDisabled(input: { identity: ReviewRunIdentity; repositoryId?: number; indexEpoch?: number; effectivePolicyDigest?: string; now?: number }): Promise<ReviewRunRecord> {
    const identityDigest = sha256(input.identity);
    const runId = deriveReviewRunId(input.identity);
    const now = new Date(input.now ?? Date.now()).toISOString();
    const result = await this.query(
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

  private async claimDisabled(runId: string, workerId: string, now: number, leaseMs: number, maxAttempts: number): Promise<ReviewRunRecord | null> {
    const result = await this.query(...claimMutation(runId, workerId, now, leaseMs, maxAttempts));
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private async claimPublicationDisabled(runId: string, workerId: string, now: number): Promise<ReviewRunRecord | null> {
    const result = await this.query(...claimPublicationMutation(runId, workerId, now));
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private async heartbeatDisabled(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.query(...heartbeatMutation(runId, workerId, now, leaseMs));
    return result.rows.length > 0;
  }

  private async recordArtifactDisabled(runId: string, stage: PiStage, digest: string, workerId: string, now: number): Promise<ReviewRunRecord> {
    const result = await this.query(...recordArtifactMutation(runId, stage, digest, workerId, now));
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot record ${stage} artifact`);
    return this.fromRow(result.rows[0]);
  }

  private async transitionDisabled(runId: string, nextStage: PiStage, workerId: string, now: number, resultDigest?: string): Promise<ReviewRunRecord> {
    const current = await this.get(runId);
    if (!current) throw new Error(`review run ${runId} not found`);
    assertStageTransition(current.stage, nextStage);
    const result = await this.query(...transitionMutation(runId, nextStage, workerId, now, current.stage, resultDigest));
    if (!result.rows[0]) throw new Error(`review run ${runId} lease is not active`);
    return this.fromRow(result.rows[0]);
  }

  private async succeedDisabled(runId: string, workerId: string, now: number, resultDigest: string): Promise<ReviewRunRecord> {
    const result = await this.query(...succeedMutation(runId, workerId, now, resultDigest));
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot succeed`);
    return this.fromRow(result.rows[0]);
  }

  private async failDisabled(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const result = await this.query(...failMutation(runId, workerId, now, error));
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot fail`);
    return this.fromRow(result.rows[0]);
  }

  private async requeueDisabled(runId: string, workerId: string, now: number, error: string): Promise<ReviewRunRecord> {
    const result = await this.query(...requeueMutation(runId, workerId, now, error));
    if (!result.rows[0]) throw new Error(`review run ${runId} cannot be requeued`);
    return this.fromRow(result.rows[0]);
  }

  private async cancelDisabled(runId: string, now: number, error: string): Promise<ReviewRunRecord | null> {
    const result = await this.query(...cancelMutation(runId, now, error));
    return result.rows[0] ? this.fromRow(result.rows[0]) : null;
  }

  private async query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number }> {
    if (typeof this.db.query !== 'function') throw new Error('PostgresReviewRunRepository requires a queryable database');
    return this.db.query(text, values);
  }

  private async withReadClient<T>(operation: (client: ReviewEventQueryable) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  private async withTransaction<T>(operation: (client: ReviewPrTransactionClient) => Promise<T>): Promise<T> {
    return withReviewPrTransaction({ connect: () => this.connect() }, operation);
  }

  private async connect(): Promise<ReviewPrTransactionClient> {
    if (typeof this.db.connect !== 'function') {
      throw new Error('PostgresReviewRunRepository lifecycle events require a connection pool');
    }
    return this.db.connect();
  }

  private async lockRun(client: ReviewEventQueryable, runId: string): Promise<any | null> {
    const hint = (await client.query(
      'SELECT repository_id, pr_number FROM review_runs WHERE run_id = $1',
      [runId],
    )).rows[0];
    if (!hint) return null;
    const repositoryId = Number(hint.repository_id);
    const prNumber = Number(hint.pr_number);
    if (!isPositiveSafeInteger(repositoryId) || !isPositiveSafeInteger(prNumber)) {
      throw new Error(`Review lifecycle run metadata is incomplete for ${runId}`);
    }
    const coordinates = assertReviewPrCoordinates(repositoryId, prNumber);
    await lockReviewPr(client, coordinates.repositoryId, coordinates.prNumber);
    const result = await client.query('SELECT * FROM review_runs WHERE run_id = $1 FOR UPDATE', [runId]);
    const row = result.rows[0];
    if (!row) return null;
    if (Number(row.repository_id) !== repositoryId || Number(row.pr_number) !== prNumber) {
      throw new Error(`Review lifecycle run binding changed while locking ${runId}`);
    }
    this.assertStoredRunIdentity(row);
    return row;
  }

  private assertStoredRunIdentity(row: any, expected?: ReviewRunIdentity): void {
    const stored = typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity;
    const rowIdentity: ReviewRunIdentity = {
      owner: row.owner,
      repo: row.repo,
      prNumber: Number(row.pr_number),
      headSha: row.head_sha,
      baseSha: row.base_sha,
      snapshotDigest: row.snapshot_digest,
      configDigest: row.config_digest,
    };
    if (!isReviewRunIdentity(stored)
      || !sameReviewRunIdentity(stored, rowIdentity)
      || sha256(stored) !== String(row.identity_digest)
      || (expected && !sameReviewRunIdentity(stored, expected))) {
      throw new Error(`inconsistent review lifecycle run identity for ${row.run_id}`);
    }
  }

  private assertRepositoryBinding(row: any, repositoryId: number, allowMissing = false): void {
    if (row.repository_id === null || row.repository_id === undefined) {
      if (allowMissing) return;
      throw new Error(`Review lifecycle run repository binding is unavailable for ${row.run_id}`);
    }
    const storedRepositoryId = Number(row.repository_id);
    if (!isPositiveSafeInteger(storedRepositoryId)) {
      throw new Error(`Review lifecycle run repository binding is invalid for ${row.run_id}`);
    }
    if (storedRepositoryId !== repositoryId) {
      throw new Error(`Conflicting review lifecycle repository binding for ${row.run_id}`);
    }
  }

  private async append(
    client: ReviewEventQueryable,
    runId: string,
    eventKind: string,
    occurredAt: number,
    data: ReviewYetiLifecycleEventV1['data'],
  ): Promise<void> {
    await appendLifecycleEventForRun(client, { runId, eventKind, occurredAt, data });
  }

  private fromRow(row: any): ReviewRunRecord {
    return {
      runId: row.run_id,
      identity: typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity,
      identityDigest: row.identity_digest,
      effectivePolicyDigest: row.effective_policy_digest || row.config_digest,
      effectiveConfigDigest: row.effective_config_digest || row.config_digest,
      indexEpoch: Number(row.index_epoch || 0),
      repositoryId: row.repository_id === null || row.repository_id === undefined ? undefined : Number(row.repository_id),
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
