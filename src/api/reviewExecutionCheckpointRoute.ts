import type { Request, Response } from 'express';
import { sha256 } from '../review/reviewCore';
import { workerExecutionAuthorized, type Queryable } from '../persistence/incrementalPriorReview';
import {
  parseReviewExecutionCheckpoint,
  reviewCheckpointReadRequestSchema,
} from '../review/reviewExecutionCheckpoint';

function token(request: Request): string | null {
  return /^Bearer\s+(ghs_[^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1] ?? null;
}
export function createReviewExecutionCheckpointHandler(queryable: Queryable) {
  return async (request: Request, response: Response) => {
    const bearer = token(request);
    if (!bearer) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const read = reviewCheckpointReadRequestSchema.safeParse(request.body);
    if (read.success) {
      try {
        if (!await workerExecutionAuthorized(queryable, { ...read.data, workerTokenDigest: sha256(bearer) })) {
          return response.status(403).json({ error: 'Worker is not authorized for this execution' });
        }
        const row = (await queryable.query('SELECT payload FROM review_execution_checkpoints WHERE run_id = $1',
          [read.data.runId])).rows[0];
        return response.status(200).json({ version: 'ReviewExecutionCheckpointReadResult.v1',
          runId: read.data.runId, executionAttempt: read.data.executionAttempt,
          checkpoint: row ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) : null });
      } catch {
        return response.status(503).json({ error: 'Review checkpoint is temporarily unavailable' });
      }
    }

    let checkpoint;
    try { checkpoint = parseReviewExecutionCheckpoint(request.body); }
    catch { return response.status(400).json({ error: 'Invalid review checkpoint' }); }
    try {
      if (!await workerExecutionAuthorized(queryable, { runId: checkpoint.runId,
        executionAttempt: checkpoint.executionAttempt, workerTokenDigest: sha256(bearer) })) {
        return response.status(403).json({ error: 'Worker is not authorized for this execution' });
      }
      const run = (await queryable.query(
        `SELECT repository_id, owner, repo, pr_number, head_sha, base_sha,
                effective_policy_digest, effective_config_digest
           FROM review_runs WHERE run_id = $1`, [checkpoint.runId])).rows[0];
      const matches = run && Number(run.repository_id) === checkpoint.repositoryId
        && String(run.owner) === checkpoint.owner && String(run.repo) === checkpoint.repo
        && Number(run.pr_number) === checkpoint.prNumber && String(run.head_sha) === checkpoint.headSha
        && String(run.base_sha) === checkpoint.baseSha
        && String(run.effective_policy_digest) === checkpoint.policyDigest
        && String(run.effective_config_digest) === checkpoint.configDigest;
      if (!matches) return response.status(403).json({ error: 'Review checkpoint does not match the admitted review' });
      const json = JSON.stringify(checkpoint);
      const result = await queryable.query(
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
      let revision = Number(result.rows[0]?.revision);
      const status = result.rows.length > 0 ? 'recorded' : 'stale';
      if (status === 'stale') {
        const current = (await queryable.query(
          'SELECT revision FROM review_execution_checkpoints WHERE run_id = $1',
          [checkpoint.runId],
        )).rows[0];
        revision = Number(current?.revision);
      }
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('Review checkpoint revision is unavailable');
      }
      return response.status(200).json({ version: 'ReviewExecutionCheckpointAccepted.v1', runId: checkpoint.runId,
        status, revision });
    } catch {
      return response.status(503).json({ error: 'Review checkpoint is temporarily unavailable' });
    }
  };
}
