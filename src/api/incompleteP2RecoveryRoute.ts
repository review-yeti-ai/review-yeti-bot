import type { Request, Response } from 'express';
import { z } from 'zod';
import { sha256 } from '../review/reviewCore';
import { workerExecutionAuthorized } from '../persistence/incrementalPriorReview';
import { loadIncompleteP2RecoveryContext, requiredIncompleteP2RecoveryDigest } from '../persistence/incompleteP2Recovery';

export interface IncompleteP2RecoveryQueryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
const requestSchema = z.object({
  version: z.literal('IncompleteP2RecoveryRequest.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().min(2).safe(),
}).strict();

/** Only the current execution's bearer may read its own retained advisory context. */
export function createIncompleteP2RecoveryHandler(queryable: IncompleteP2RecoveryQueryable) {
  return async (request: Request, response: Response) => {
    const token = /^Bearer\s+(ghs_[^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1];
    if (!token) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid retained findings request' });
    try {
      const input = parsed.data;
      if (!await workerExecutionAuthorized(queryable, { ...input, workerTokenDigest: sha256(token) })) {
        return response.status(403).json({ error: 'Worker is not authorized for this execution' });
      }
      const row = (await queryable.query('SELECT identity, repository_id, effective_policy_digest, authoritative_gate_app_id, artifacts FROM review_runs WHERE run_id = $1', [input.runId])).rows[0];
      if (!row) throw new Error('Current retained findings binding is unavailable');
      const artifacts = typeof row.artifacts === 'string' ? JSON.parse(row.artifacts) : row.artifacts;
      const requiredDigest = await requiredIncompleteP2RecoveryDigest(queryable, input.runId, input.executionAttempt, artifacts);
      const identity = typeof row.identity === 'string' ? JSON.parse(row.identity) : row.identity;
      const context = requiredDigest === null ? null : await loadIncompleteP2RecoveryContext(queryable, {
        runId: input.runId, executionAttempt: input.executionAttempt, repositoryId: Number(row.repository_id),
        identity,
        policyDigest: row.effective_policy_digest, expectedAppId: Number(row.authoritative_gate_app_id),
        expectedContextDigest: requiredDigest,
      });
      if (requiredDigest !== null && context?.contextDigest !== requiredDigest) throw new Error('Retained findings digest mismatch');
      return response.status(200).json({ version: 'IncompleteP2RecoveryResponse.v1',
        runId: input.runId, executionAttempt: input.executionAttempt, context });
    } catch {
      return response.status(503).json({ error: 'Retained findings are temporarily unavailable' });
    }
  };
}
