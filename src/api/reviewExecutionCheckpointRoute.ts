import type { Request, Response } from 'express';
import { canonicalJson, sha256 } from '../review/reviewCore';
import { workerExecutionAuthorized, type Queryable } from '../persistence/incrementalPriorReview';
import { lockReviewPr, withReviewPrTransaction, type ReviewPrTransactionPool } from '../persistence/reviewPrTransaction';
import { loadValidatedDisputedFindingRechecks, type DisputedFindingRecheck } from '../review/disputedFindingRecheck';
import {
  parseReviewExecutionCheckpoint,
  reviewCheckpointReadRequestSchema,
  type ReviewExecutionCheckpoint,
} from '../review/reviewExecutionCheckpoint';

type CheckpointDatabase = Queryable & Partial<ReviewPrTransactionPool>;

function token(request: Request): string | null {
  return /^Bearer\s+(ghs_[^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1] ?? null;
}

function jsonValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function assertRunIdentity(run: any, identity: {
  runId: string; repositoryId: number; owner: string; repo: string; prNumber: number;
  headSha: string; baseSha: string; policyDigest: string; configDigest: string;
}): void {
  if (!run || String(run.run_id) !== identity.runId || Number(run.repository_id) !== identity.repositoryId
    || String(run.owner) !== identity.owner || String(run.repo) !== identity.repo
    || Number(run.pr_number) !== identity.prNumber || String(run.head_sha) !== identity.headSha
    || String(run.base_sha) !== identity.baseSha || String(run.effective_policy_digest) !== identity.policyDigest
    || String(run.effective_config_digest) !== identity.configDigest) {
    throw new Error('Review checkpoint does not match its admitted review');
  }
}

const RUN_IDENTITY_SELECT = `SELECT run_id, repository_id, owner, repo, pr_number, head_sha, base_sha,
       effective_policy_digest, effective_config_digest
  FROM review_runs WHERE run_id = $1`;

async function validatedRechecks(queryable: Queryable, run: any, currentAttempt: number): Promise<DisputedFindingRecheck[]> {
  return loadValidatedDisputedFindingRechecks(queryable, run, currentAttempt);
}

function checkpointSatisfiedIds(checkpoint: ReviewExecutionCheckpoint | null): Set<string> {
  return new Set(checkpoint?.satisfiedFindingRecheckIds ?? []);
}

async function readCheckpoint(queryable: Queryable, runId: string): Promise<ReviewExecutionCheckpoint | null> {
  const row = (await queryable.query('SELECT payload FROM review_execution_checkpoints WHERE run_id = $1', [runId])).rows[0];
  return row ? parseReviewExecutionCheckpoint(jsonValue(row.payload)) : null;
}

function pendingRechecks(rechecks: DisputedFindingRecheck[], checkpoint: ReviewExecutionCheckpoint | null,
  currentAttempt: number): DisputedFindingRecheck[] {
  const satisfied = checkpointSatisfiedIds(checkpoint);
  const byId = new Map(rechecks.map((recheck) => [recheck.requestId, recheck]));
  if ([...satisfied].some((requestId) => !byId.has(requestId))) {
    throw new Error('Checkpoint contains an unknown disputed finding receipt');
  }
  if (rechecks.length > 0 && !checkpoint) throw new Error('Disputed finding checkpoint is unavailable');
  if (checkpoint) {
    if (checkpoint.executionAttempt > currentAttempt) throw new Error('Checkpoint belongs to a future execution');
    for (const recheck of rechecks) {
      if (sha256(canonicalJson(checkpoint.plan)) !== recheck.sourcePlanDigest) {
        throw new Error('Disputed finding request no longer matches the composed task plan');
      }
      if (satisfied.has(recheck.requestId)
        && !checkpoint.completedTasks.some((task) => task.id === recheck.taskId)) {
        throw new Error('Satisfied disputed finding receipt has no completed task');
      }
    }
  }
  return rechecks.filter((recheck) => !satisfied.has(recheck.requestId));
}

async function assertSatisfiedReceipts(queryable: Queryable, checkpoint: ReviewExecutionCheckpoint,
  previous: ReviewExecutionCheckpoint | null): Promise<void> {
  const currentIds = checkpointSatisfiedIds(checkpoint);
  const priorIds = checkpointSatisfiedIds(previous);
  if ([...priorIds].some((requestId) => !currentIds.has(requestId))) {
    throw new Error('Checkpoint cannot remove a completed disputed finding receipt');
  }
  if (currentIds.size === 0) return;
  const run = (await queryable.query(RUN_IDENTITY_SELECT, [checkpoint.runId])).rows[0];
  assertRunIdentity(run, checkpoint);
  const rechecks = await validatedRechecks(queryable, run, checkpoint.executionAttempt);
  const byId = new Map(rechecks.map((recheck) => [recheck.requestId, recheck]));
  const planDigest = sha256(canonicalJson(checkpoint.plan));
  for (const requestId of currentIds) {
    const recheck = byId.get(requestId);
    if (!recheck || recheck.sourcePlanDigest !== planDigest
      || !checkpoint.completedTasks.some((task) => task.id === recheck.taskId)) {
      throw new Error('Checkpoint receipt is not backed by a completed disputed task');
    }
  }
}

export function createReviewExecutionCheckpointHandler(queryable: CheckpointDatabase) {
  return async (request: Request, response: Response) => {
    const bearer = token(request);
    if (!bearer) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const read = reviewCheckpointReadRequestSchema.safeParse(request.body);
    if (read.success) {
      try {
        const result = await withReviewPrTransactionIfAvailable(queryable, read.data.runId, async (client, run) => {
          if (!await workerExecutionAuthorized(client, { ...read.data, workerTokenDigest: sha256(bearer) })) {
            return { status: 403 as const };
          }
          const checkpoint = await readCheckpoint(client, read.data.runId);
          if (checkpoint) assertRunIdentity(run, checkpoint);
          const rechecks = await validatedRechecks(client, run, read.data.executionAttempt);
          const pending = pendingRechecks(rechecks, checkpoint, read.data.executionAttempt);
          return { status: 200 as const, checkpoint, disputedFindingRechecks: pending };
        });
        if (result.status === 403) return response.status(403).json({ error: 'Worker is not authorized for this execution' });
        return response.status(200).json({ version: 'ReviewExecutionCheckpointReadResult.v1',
          runId: read.data.runId, executionAttempt: read.data.executionAttempt,
          checkpoint: result.checkpoint, disputedFindingRechecks: result.disputedFindingRechecks });
      } catch {
        return response.status(503).json({ error: 'Review checkpoint is temporarily unavailable' });
      }
    }

    let checkpoint: ReviewExecutionCheckpoint;
    try { checkpoint = parseReviewExecutionCheckpoint(request.body); }
    catch { return response.status(400).json({ error: 'Invalid review checkpoint' }); }
    try {
      const result = await withReviewPrTransactionIfAvailable(queryable, checkpoint.runId, async (client, run) => {
        if (!await workerExecutionAuthorized(client, { runId: checkpoint.runId,
          executionAttempt: checkpoint.executionAttempt, workerTokenDigest: sha256(bearer) })) {
          return { status: 403 as const };
        }
        assertRunIdentity(run, checkpoint);
        const previous = await readCheckpoint(client, checkpoint.runId);
        await assertSatisfiedReceipts(client, checkpoint, previous);
        const json = JSON.stringify(checkpoint);
        const saved = await client.query(
          `INSERT INTO review_execution_checkpoints
             (run_id, execution_attempt, revision, head_sha, config_digest, payload, byte_length, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, CURRENT_TIMESTAMP)
           ON CONFLICT (run_id) DO UPDATE SET
             execution_attempt = EXCLUDED.execution_attempt,
             revision = EXCLUDED.revision,
             head_sha = EXCLUDED.head_sha,
             config_digest = EXCLUDED.config_digest,
             payload = EXCLUDED.payload,
             byte_length = EXCLUDED.byte_length,
             updated_at = CURRENT_TIMESTAMP
           WHERE review_execution_checkpoints.revision < EXCLUDED.revision
           RETURNING revision`,
          [checkpoint.runId, checkpoint.executionAttempt, checkpoint.revision, checkpoint.headSha,
            checkpoint.configDigest, json, Buffer.byteLength(json, 'utf8')],
        );
        let revision = Number(saved.rows[0]?.revision);
        const writeStatus = saved.rows.length > 0 ? 'recorded' : 'stale';
        if (writeStatus === 'stale') {
          const current = (await client.query('SELECT revision FROM review_execution_checkpoints WHERE run_id = $1',
            [checkpoint.runId])).rows[0];
          revision = Number(current?.revision);
        }
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Review checkpoint revision is unavailable');
        return { status: 200 as const, revision, writeStatus };
      });
      if (result.status === 403) return response.status(403).json({ error: 'Worker is not authorized for this execution' });
      return response.status(200).json({ version: 'ReviewExecutionCheckpointAccepted.v1', runId: checkpoint.runId,
        status: result.writeStatus, revision: result.revision });
    } catch {
      return response.status(503).json({ error: 'Review checkpoint is temporarily unavailable' });
    }
  };
}

async function withReviewPrTransactionIfAvailable<T>(queryable: CheckpointDatabase, runId: string,
  operation: (client: Queryable, run: any) => Promise<T>): Promise<T> {
  const runWithoutLock = async (client: Queryable): Promise<T> => {
    const run = (await client.query(RUN_IDENTITY_SELECT, [runId])).rows[0];
    if (!run) throw new Error('Review run does not exist');
    return operation(client, run);
  };
  if (typeof queryable.connect !== 'function') return runWithoutLock(queryable);
  return withReviewPrTransaction(queryable as ReviewPrTransactionPool, async (client) => {
    const hint = (await client.query('SELECT repository_id, pr_number FROM review_runs WHERE run_id = $1', [runId])).rows[0];
    if (!hint) throw new Error('Review run does not exist');
    const repositoryId = Number(hint.repository_id);
    const prNumber = Number(hint.pr_number);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new Error('Review run coordinates are invalid');
    }
    await client.query("SET LOCAL lock_timeout = '5s'");
    await lockReviewPr(client, repositoryId, prNumber);
    const run = (await client.query(RUN_IDENTITY_SELECT, [runId])).rows[0];
    if (!run || Number(run.repository_id) !== repositoryId || Number(run.pr_number) !== prNumber) {
      throw new Error('Review run coordinates changed');
    }
    return operation(client, run);
  });
}
