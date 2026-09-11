import {
  appendLifecycleEventForRun,
  requireLifecycleEventsMode,
  type ReviewLifecycleEventsOptions,
} from './reviewEventRepository';

export type ReviewCompletionStatus =
  | 'pending'
  | 'claimed'
  | 'dispatched'
  | 'completed'
  | 'error'
  | 'superseded'
  | 'terminal';

export interface ReviewCompletionRecord {
  completionId: string;
  runId: string;
  deliveryId?: string;
  repositoryId: number;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  attemptId: string;
  policyDigest: string;
  validationRequestId: string;
  status: ReviewCompletionStatus;
  draftDeferred: boolean;
  verdict?: string;
  conclusion?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  attempt: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  errorText?: string;
}

export interface ReviewCompletionRecordInput {
  completionId?: string;
  runId: string;
  deliveryId?: string;
  repositoryId: number;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  attemptId: string;
  policyDigest: string;
  validationRequestId?: string;
  status?: ReviewCompletionStatus;
  draftDeferred?: boolean;
  verdict?: string;
  conclusion?: string;
  availableAt?: number;
  errorText?: string;
}

export interface ReviewCompletionClaim {
  completionId: string;
  runId: string;
  deliveryId?: string;
  repositoryId: number;
  repository: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  attemptId: string;
  policyDigest: string;
  validationRequestId: string;
  verdict?: string;
  conclusion?: string;
  attempt: number;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface ReviewCompletionRepository {
  recordCompletion(input: ReviewCompletionRecordInput): Promise<ReviewCompletionRecord>;
  claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewCompletionClaim | null>;
  heartbeat(completionId: string, workerId: string, now: number, leaseMs: number): Promise<boolean>;
  markDispatched(completionId: string, workerId: string, now: number): Promise<boolean>;
  markCompleted(completionId: string, workerId: string, now: number): Promise<boolean>;
  markTerminal(completionId: string, workerId: string, now: number): Promise<boolean>;
  releaseForRetry(completionId: string, workerId: string, now: number, delayMs: number, errorText?: string): Promise<boolean>;
  markError(completionId: string, workerId: string, now: number, errorText: string): Promise<boolean>;
  markReady(repositoryId: number, prNumber: number, headSha: string, now: number): Promise<number>;
  supersedeOlderHeads(repositoryId: number, prNumber: number, currentHeadSha: string, now: number): Promise<number>;
  getByValidationRequestId(validationRequestId: string): Promise<ReviewCompletionRecord | null>;
  getByRunId(runId: string): Promise<ReviewCompletionRecord | null>;
}

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
  query?(text: string, values?: unknown[]): Promise<QueryResult>;
}

export type ReviewCompletionRepositoryOptions = ReviewLifecycleEventsOptions;

function milliseconds(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function rowToRecord(row: any): ReviewCompletionRecord {
  return {
    completionId: row.completion_id,
    runId: row.run_id,
    deliveryId: row.delivery_id || undefined,
    repositoryId: Number(row.repository_id),
    repository: row.repository,
    prNumber: Number(row.pr_number),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    attemptId: row.attempt_id,
    policyDigest: row.policy_digest,
    validationRequestId: row.validation_request_id,
    status: row.status as ReviewCompletionStatus,
    draftDeferred: Boolean(row.draft_deferred),
    verdict: row.verdict || undefined,
    conclusion: row.conclusion || undefined,
    leaseOwner: row.lease_owner || undefined,
    leaseExpiresAt: milliseconds(row.lease_expires_at),
    attempt: Number(row.attempt || 0),
    availableAt: milliseconds(row.available_at) || 0,
    createdAt: milliseconds(row.created_at) || 0,
    updatedAt: milliseconds(row.updated_at) || 0,
    errorText: row.error_text || undefined,
  };
}

function rowToClaim(row: any): ReviewCompletionClaim {
  return {
    completionId: row.completion_id,
    runId: row.run_id,
    deliveryId: row.delivery_id || undefined,
    repositoryId: Number(row.repository_id),
    repository: row.repository,
    prNumber: Number(row.pr_number),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    attemptId: row.attempt_id,
    policyDigest: row.policy_digest,
    validationRequestId: row.validation_request_id,
    verdict: row.verdict || undefined,
    conclusion: row.conclusion || undefined,
    attempt: Number(row.attempt || 0),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: milliseconds(row.lease_expires_at) || 0,
  };
}

export class PostgresReviewCompletionRepository implements ReviewCompletionRepository {
  private readonly lifecycleEventsEnabled: boolean;

  constructor(private readonly pool: ConnectionPool | Queryable, options: ReviewCompletionRepositoryOptions) {
    this.lifecycleEventsEnabled = requireLifecycleEventsMode(options, 'Review completion repository');
    if (this.lifecycleEventsEnabled && (!('connect' in pool) || typeof pool.connect !== 'function')) {
      throw new Error('Review completion lifecycle events require a connection pool');
    }
  }

  private async executeQuery(text: string, values?: unknown[]): Promise<QueryResult> {
    if ('connect' in this.pool && typeof this.pool.connect === 'function') {
      const client = await this.pool.connect();
      try {
        return await client.query(text, values);
      } finally {
        client.release();
      }
    }
    return (this.pool as Queryable).query(text, values);
  }

  private async appendLifecycle(
    client: Queryable,
    runId: string,
    eventKind: string,
    now: number,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.lifecycleEventsEnabled) return;
    await appendLifecycleEventForRun(client, { runId, eventKind, occurredAt: now, data });
  }

  private async mutate<T>(operation: (client: TransactionClient) => Promise<T>): Promise<T> {
    const pool = this.pool as ConnectionPool | Queryable;
    if (!this.lifecycleEventsEnabled) {
      if ('connect' in pool && typeof pool.connect === 'function') {
        const client = await pool.connect();
        try { return await operation(client); } finally { client.release(); }
      }
      return operation({ query: (text, values) => (pool as Queryable).query(text, values), release: () => undefined });
    }
    const client = await (pool as ConnectionPool).connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordCompletion(input: ReviewCompletionRecordInput): Promise<ReviewCompletionRecord> {
    const completionId = input.completionId || `cpl_${input.runId.replace(/^run_/, '')}`;
    const validationRequestId = input.validationRequestId || `validation-${input.prNumber}-${input.attemptId}`;
    const status = input.status || 'pending';
    const draftDeferred = Boolean(input.draftDeferred);
    const availableAt = input.availableAt ?? Date.now();

    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `INSERT INTO review_completion_outbox
        (completion_id, run_id, delivery_id, repository_id, repository, pr_number,
         base_sha, head_sha, attempt_id, policy_digest, validation_request_id,
         status, draft_deferred, verdict, conclusion, error_text,
         available_at, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         to_timestamp($17 / 1000.0), to_timestamp($17 / 1000.0), to_timestamp($17 / 1000.0))
       ON CONFLICT (validation_request_id) DO UPDATE
         SET verdict = EXCLUDED.verdict,
             conclusion = EXCLUDED.conclusion,
             draft_deferred = EXCLUDED.draft_deferred,
             error_text = EXCLUDED.error_text,
             updated_at = EXCLUDED.updated_at
         WHERE review_completion_outbox.completion_id = EXCLUDED.completion_id
           AND review_completion_outbox.run_id = EXCLUDED.run_id
           AND review_completion_outbox.delivery_id IS NOT DISTINCT FROM EXCLUDED.delivery_id
           AND review_completion_outbox.repository_id = EXCLUDED.repository_id
           AND review_completion_outbox.repository = EXCLUDED.repository
           AND review_completion_outbox.pr_number = EXCLUDED.pr_number
           AND review_completion_outbox.base_sha = EXCLUDED.base_sha
           AND review_completion_outbox.head_sha = EXCLUDED.head_sha
           AND review_completion_outbox.attempt_id = EXCLUDED.attempt_id
           AND review_completion_outbox.policy_digest = EXCLUDED.policy_digest
       RETURNING *, (xmax = 0) AS inserted`,
      [
        completionId,
        input.runId,
        input.deliveryId || null,
        input.repositoryId,
        input.repository,
        input.prNumber,
        input.baseSha,
        input.headSha,
        input.attemptId,
        input.policyDigest,
        validationRequestId,
        status,
        draftDeferred,
        input.verdict || null,
        input.conclusion || null,
        input.errorText || null,
        availableAt,
      ],
      );
      if (result.rows.length > 0) {
        const persisted = rowToRecord(result.rows[0]);
        if (result.rows[0].inserted === true || result.rows[0].inserted === 't') {
          await this.appendLifecycle(client, persisted.runId, 'review.lifecycle.queued', availableAt,
            { stage: 'completion' });
        }
        return result;
      }
      const conflicting = await client.query(
        'SELECT * FROM review_completion_outbox WHERE validation_request_id = $1 FOR UPDATE',
        [validationRequestId],
      );
      if (conflicting.rows.length === 0) {
        throw new Error('Review completion replay disappeared before identity validation');
      }
      throw new Error('Review completion validation request identity conflict');
    });

    return rowToRecord(result.rows[0]);
  }

  async claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewCompletionClaim | null> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `WITH candidate AS (
         SELECT completion_id
           FROM review_completion_outbox
          WHERE draft_deferred = FALSE
            AND (
              (status = 'pending' AND available_at <= to_timestamp($2 / 1000.0))
              OR (status = 'claimed' AND lease_expires_at <= to_timestamp($2 / 1000.0))
            )
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
        UPDATE review_completion_outbox AS outbox
          SET status = 'claimed',
              lease_owner = $1,
              lease_expires_at = to_timestamp(($2::numeric + $3::numeric) / 1000.0),
              attempt = attempt + 1,
              updated_at = to_timestamp($2 / 1000.0)
         FROM candidate
        WHERE outbox.completion_id = candidate.completion_id
       RETURNING outbox.*`,
      [workerId, now, leaseMs],
      );
      return result;
    });

    if (result.rows.length === 0) {
      return null;
    }
    return rowToClaim(result.rows[0]);
  }

  async heartbeat(completionId: string, workerId: string, now: number, leaseMs: number): Promise<boolean> {
    const result = await this.executeQuery(
      `UPDATE review_completion_outbox
          SET lease_expires_at = to_timestamp(($3::numeric + $4::numeric) / 1000.0),
              updated_at = to_timestamp($3 / 1000.0)
        WHERE completion_id = $1
          AND lease_owner = $2
          AND status = 'claimed'`,
      [completionId, workerId, now, leaseMs],
    );
    return (result.rows.length > 0 || (result as any).rowCount > 0);
  }

  async markDispatched(completionId: string, workerId: string, now: number): Promise<boolean> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'dispatched',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = to_timestamp($3 / 1000.0)
        WHERE completion_id = $1
          AND lease_owner = $2
          AND status = 'claimed'
       RETURNING completion_id, run_id`,
      [completionId, workerId, now],
      );
      if (result.rows.length > 0) {
        if (result.rows[0].run_id) await this.appendLifecycle(client, String(result.rows[0].run_id), 'review.lifecycle.dispatched', now,
          { stage: 'completion' });
      }
      return result;
    });
    return result.rows.length > 0;
  }

  async markCompleted(completionId: string, workerId: string, now: number): Promise<boolean> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'completed',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = to_timestamp($3 / 1000.0)
        WHERE completion_id = $1
          AND (lease_owner = $2 OR lease_owner IS NULL)
          AND status IN ('claimed', 'dispatched')
       RETURNING completion_id, run_id`,
      [completionId, workerId, now],
      );
      if (result.rows.length > 0) {
        if (result.rows[0].run_id) await this.appendLifecycle(client, String(result.rows[0].run_id), 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'completion_completed' });
      }
      return result;
    });
    return result.rows.length > 0;
  }

  async markTerminal(completionId: string, workerId: string, now: number): Promise<boolean> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'terminal',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = to_timestamp($3 / 1000.0)
        WHERE completion_id = $1
          AND (lease_owner = $2 OR lease_owner IS NULL)
          AND status IN ('claimed', 'dispatched', 'pending')
       RETURNING completion_id, run_id`,
      [completionId, workerId, now],
      );
      if (result.rows.length > 0) {
        if (result.rows[0].run_id) await this.appendLifecycle(client, String(result.rows[0].run_id), 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'completion_terminal' });
      }
      return result;
    });
    return result.rows.length > 0;
  }

  async releaseForRetry(
    completionId: string,
    workerId: string,
    now: number,
    delayMs: number,
    errorText?: string,
  ): Promise<boolean> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'pending',
              lease_owner = NULL,
              lease_expires_at = NULL,
              available_at = to_timestamp(($3::numeric + $4::numeric) / 1000.0),
              error_text = COALESCE($5, error_text),
              updated_at = to_timestamp($3 / 1000.0)
        WHERE completion_id = $1
          AND lease_owner = $2
          AND status = 'claimed'
       RETURNING completion_id, run_id`,
      [completionId, workerId, now, delayMs, errorText || null],
      );
      if (result.rows.length > 0 && result.rows[0].run_id) {
        await this.appendLifecycle(client, String(result.rows[0].run_id), 'review.lifecycle.retrying', now,
          { stage: 'completion', retry_class: 'delivery_retry' });
      }
      return result;
    });
    return result.rows.length > 0;
  }

  async markError(
    completionId: string,
    workerId: string,
    now: number,
    errorText: string,
  ): Promise<boolean> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'error',
              lease_owner = NULL,
              lease_expires_at = NULL,
              error_text = $3,
              updated_at = to_timestamp($4 / 1000.0)
        WHERE completion_id = $1
          AND lease_owner = $2
          AND status = 'claimed'
       RETURNING completion_id, run_id`,
      [completionId, workerId, errorText, now],
      );
      if (result.rows.length > 0 && result.rows[0].run_id) {
        await this.appendLifecycle(client, String(result.rows[0].run_id), 'review.lifecycle.terminal', now,
          { stage: 'terminal', terminal_class: 'completion_error' });
      }
      return result;
    });
    return result.rows.length > 0;
  }

  async markReady(
    repositoryId: number,
    prNumber: number,
    headSha: string,
    now: number,
  ): Promise<number> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET draft_deferred = FALSE,
              updated_at = to_timestamp($4 / 1000.0)
        WHERE repository_id = $1
          AND pr_number = $2
          AND head_sha = $3
          AND draft_deferred = TRUE
       RETURNING completion_id, run_id`,
      [repositoryId, prNumber, headSha, now],
      );
      for (const row of result.rows) {
        if (row.run_id) await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.queued', now,
          { stage: 'completion' });
      }
      return result;
    });
    return result.rows.length;
  }

  async supersedeOlderHeads(
    repositoryId: number,
    prNumber: number,
    currentHeadSha: string,
    now: number,
  ): Promise<number> {
    const result = await this.mutate(async (client) => {
      const result = await client.query(
      `UPDATE review_completion_outbox
          SET status = 'superseded',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = to_timestamp($4 / 1000.0)
        WHERE repository_id = $1
          AND pr_number = $2
          AND head_sha <> $3
          AND status IN ('pending', 'claimed')
       RETURNING completion_id, run_id`,
      [repositoryId, prNumber, currentHeadSha, now],
      );
      for (const row of result.rows) {
        if (row.run_id) await this.appendLifecycle(client, String(row.run_id), 'review.lifecycle.superseded', now,
          { stage: 'superseded', terminal_class: 'candidate_superseded' });
      }
      return result;
    });
    return result.rows.length;
  }

  async getByValidationRequestId(validationRequestId: string): Promise<ReviewCompletionRecord | null> {
    const result = await this.executeQuery(
      `SELECT * FROM review_completion_outbox WHERE validation_request_id = $1`,
      [validationRequestId],
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  }

  async getByRunId(runId: string): Promise<ReviewCompletionRecord | null> {
    const result = await this.executeQuery(
      `SELECT * FROM review_completion_outbox WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  }
}
