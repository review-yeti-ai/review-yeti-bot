import { sha256 } from '../review/reviewCore';
import {
  ReviewAdmission,
  ReviewAdmissionInput,
  ReviewDispatchClaim,
  ReviewRun,
} from '../review/reviewRun';

interface QueryResult {
  rows: any[];
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface ConnectionPool {
  connect(): Promise<TransactionClient>;
}

function milliseconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function fromRow(row: any): ReviewRun {
  return {
    runId: row.run_id,
    identity: typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity,
    identityDigest: row.identity_digest,
    effectivePolicyDigest: row.effective_policy_digest || row.config_digest,
    effectiveConfigDigest: row.effective_config_digest || row.config_digest,
    indexEpoch: Number(row.index_epoch || 0),
    repositoryId: row.repository_id === null || row.repository_id === undefined ? undefined : Number(row.repository_id),
    installationId: row.installation_id === null || row.installation_id === undefined ? undefined : Number(row.installation_id),
    deliveryId: row.delivery_id || undefined,
    receivedAt: milliseconds(row.received_at),
    terminalDeadline: milliseconds(row.terminal_deadline),
    status: row.status,
    stage: row.stage,
    attempt: Number(row.attempt || 0),
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: milliseconds(row.lease_expires_at),
    artifacts: typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : (row.artifacts || {}),
    publicationFence: row.publication_fence || undefined,
    resultDigest: row.result_digest || undefined,
    error: row.error_text || undefined,
    createdAt: milliseconds(row.created_at) || 0,
    updatedAt: milliseconds(row.updated_at) || 0,
  };
}

function validateAdmission(input: ReviewAdmissionInput): void {
  if (!input.deliveryId.trim()) throw new Error('delivery id is required');
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new Error('repository id must be positive');
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0) throw new Error('installation id must be positive');
  if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest)) throw new Error('payload digest must be 64 lowercase hex characters');
  if (!Number.isFinite(input.receivedAt) || input.terminalDeadline !== input.receivedAt + 900_000) {
    throw new Error('terminal deadline must be exactly 15 minutes after receipt');
  }
}

export interface ReviewDispatchRepository {
  admit(input: ReviewAdmissionInput): Promise<ReviewAdmission>;
  claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewDispatchClaim | null>;
  heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean>;
  markProjected(runId: string, workerId: string, projectionName: string, now: number): Promise<boolean>;
  releaseForRetry(runId: string, workerId: string, now: number, availableAt: number): Promise<boolean>;
  markTerminal(runId: string, now: number): Promise<boolean>;
}

export class PostgresReviewDispatchRepository implements ReviewDispatchRepository {
  private readonly queryable: Queryable;

  constructor(private readonly pool: ConnectionPool, queryable?: Queryable) {
    const possiblePool = pool as unknown as Partial<Queryable>;
    this.queryable = queryable || (typeof possiblePool.query === 'function' ? possiblePool as Queryable : {
      query: async () => { throw new Error('direct PostgreSQL query interface is unavailable'); },
    });
  }

  async admit(input: ReviewAdmissionInput): Promise<ReviewAdmission> {
    validateAdmission(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`review-dispatch:${input.repositoryId}:${input.identity.prNumber}`],
      );
      const delivery = await client.query(
        `INSERT INTO github_deliveries
           (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING delivery_id`,
        [input.deliveryId, input.eventName, input.repositoryId, input.installationId, input.payloadDigest, input.receivedAt],
      );

      if (delivery.rows.length === 0) {
        const existing = await client.query(
          `SELECT runs.*, deliveries.payload_digest, deliveries.repository_id
             FROM github_deliveries AS deliveries
             JOIN review_runs AS runs ON runs.run_id = deliveries.run_id
            WHERE deliveries.delivery_id = $1`,
          [input.deliveryId],
        );
        const row = existing.rows[0];
        if (!row || row.payload_digest !== input.payloadDigest || Number(row.repository_id) !== input.repositoryId) {
          throw new Error('delivery identity conflict: delivery id was already used for another payload or repository');
        }
        await client.query('COMMIT');
        return {
          status: 'duplicate',
          deliveryId: input.deliveryId,
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          receivedAt: input.receivedAt,
          terminalDeadline: input.terminalDeadline,
          payloadDigest: input.payloadDigest,
          run: fromRow(row),
        };
      }

      const identityDigest = sha256(input.identity);
      const runId = `run_${identityDigest.slice(0, 32)}`;
      await client.query(
        `WITH superseded AS (
           UPDATE review_runs
              SET status = 'superseded',
                  error_text = 'superseded by a newer pull request head',
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = to_timestamp($5 / 1000.0)
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
              AND head_sha <> $4 AND status IN ('queued', 'running')
          RETURNING run_id
         )
         UPDATE review_dispatch_outbox AS outbox
            SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
                updated_at = to_timestamp($5 / 1000.0)
          WHERE outbox.run_id IN (SELECT run_id FROM superseded)`,
        [input.identity.owner, input.identity.repo, input.identity.prNumber, input.identity.headSha, input.receivedAt],
      );

      const inserted = await client.query(
        `INSERT INTO review_runs
           (run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
            snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
            index_epoch, identity, status, stage, attempt, artifacts, repository_id,
            installation_id, delivery_id, received_at, terminal_deadline, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9, $11, $12,
            'queued', 'admission', 0, '{}'::jsonb, $13, $14, $15,
            to_timestamp($16 / 1000.0), to_timestamp($17 / 1000.0),
            to_timestamp($16 / 1000.0), to_timestamp($16 / 1000.0))
         ON CONFLICT (identity_digest) DO UPDATE
           SET updated_at = review_runs.updated_at
         RETURNING *`,
        [
          runId,
          identityDigest,
          input.identity.owner,
          input.identity.repo,
          input.identity.prNumber,
          input.identity.headSha,
          input.identity.baseSha,
          input.identity.snapshotDigest,
          input.identity.configDigest,
          input.effectivePolicyDigest || input.identity.configDigest,
          input.indexEpoch || 0,
          JSON.stringify(input.identity),
          input.repositoryId,
          input.installationId,
          input.deliveryId,
          input.receivedAt,
          input.terminalDeadline,
        ],
      );
      const runRow = inserted.rows[0];
      if (!runRow) throw new Error('review run admission did not return a run');

      await client.query(
        'UPDATE github_deliveries SET run_id = $2 WHERE delivery_id = $1',
        [input.deliveryId, runRow.run_id],
      );
      await client.query(
        `INSERT INTO review_dispatch_outbox (run_id, delivery_id, status, available_at, created_at, updated_at)
         VALUES ($1, $2, 'pending', to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
         ON CONFLICT (run_id) DO NOTHING`,
        [runRow.run_id, input.deliveryId, input.receivedAt],
      );
      await client.query('COMMIT');
      return {
        status: 'accepted',
        deliveryId: input.deliveryId,
        repositoryId: input.repositoryId,
        installationId: input.installationId,
        receivedAt: input.receivedAt,
        terminalDeadline: input.terminalDeadline,
        payloadDigest: input.payloadDigest,
        run: fromRow(runRow),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewDispatchClaim | null> {
    const result = await this.queryable.query(
      `WITH candidate AS (
         SELECT outbox.run_id
           FROM review_dispatch_outbox AS outbox
           JOIN review_runs AS runs ON runs.run_id = outbox.run_id
          WHERE runs.status = 'queued'
            AND runs.terminal_deadline > to_timestamp($2 / 1000.0)
            AND outbox.available_at <= to_timestamp($2 / 1000.0)
            AND (outbox.status = 'pending'
              OR (outbox.status = 'claimed' AND outbox.lease_expires_at <= to_timestamp($2 / 1000.0)))
          ORDER BY outbox.available_at, outbox.created_at
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT 1
       )
       UPDATE review_dispatch_outbox AS outbox
          SET status = 'claimed', lease_owner = $1,
              lease_expires_at = to_timestamp(($2 + $3) / 1000.0),
              attempt = attempt + 1, updated_at = to_timestamp($2 / 1000.0)
         FROM candidate, github_deliveries AS deliveries
        WHERE outbox.run_id = candidate.run_id
          AND deliveries.delivery_id = outbox.delivery_id
       RETURNING outbox.run_id, outbox.delivery_id, deliveries.repository_id,
                 deliveries.installation_id, outbox.lease_owner, outbox.lease_expires_at`,
      [workerId, now, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      runId: row.run_id,
      deliveryId: row.delivery_id,
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: milliseconds(row.lease_expires_at) || 0,
    } : null;
  }

  async heartbeat(runId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET lease_expires_at = to_timestamp(($3 + $4) / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
          AND lease_expires_at > to_timestamp($3 / 1000.0)
      RETURNING run_id`,
      [runId, workerId, now, leaseMs],
    );
    return result.rows.length > 0;
  }

  async markProjected(runId: string, workerId: string, projectionName: string, now: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'projected', projection_name = $3, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = to_timestamp($4 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
      RETURNING run_id`,
      [runId, workerId, projectionName, now],
    );
    return result.rows.length > 0;
  }

  async releaseForRetry(runId: string, workerId: string, now: number, availableAt: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              available_at = to_timestamp($4 / 1000.0), updated_at = to_timestamp($3 / 1000.0)
        WHERE run_id = $1 AND lease_owner = $2 AND status = 'claimed'
      RETURNING run_id`,
      [runId, workerId, now, availableAt],
    );
    return result.rows.length > 0;
  }

  async markTerminal(runId: string, now: number): Promise<boolean> {
    const result = await this.queryable.query(
      `UPDATE review_dispatch_outbox
          SET status = 'terminal', lease_owner = NULL, lease_expires_at = NULL,
              updated_at = to_timestamp($2 / 1000.0)
        WHERE run_id = $1 AND status <> 'terminal'
      RETURNING run_id`,
      [runId, now],
    );
    return result.rows.length > 0;
  }
}
