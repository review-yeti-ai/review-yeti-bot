/**
 * REL-1084: `POST /api/dispatch/incremental-base`. A publishing worker asks,
 * with its own per-run bearer, for the prior review record an incremental
 * re-review may carry forward from. The answer is only a planning hint: the
 * trusted completion side selects and verifies the same record again, so a
 * wrong or missing answer can at worst cost a full review.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sha256 } from '../review/reviewCore';
import type { IncrementalBaseLookup } from '../persistence/incrementalPriorReview';
import { logger } from '../utils/logger';

export const INCREMENTAL_BASE_REQUEST_VERSION = 'IncrementalBaseRequest.v1' as const;
export const INCREMENTAL_BASE_RESPONSE_VERSION = 'IncrementalBase.v1' as const;

const requestSchema = z.object({
  version: z.literal(INCREMENTAL_BASE_REQUEST_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
}).strict();

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+([^\s]+)$/iu.exec(request.header('authorization') || '');
  return match?.[1] || null;
}

export function createIncrementalBaseHandler(lookup: IncrementalBaseLookup) {
  return async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token || !token.startsWith('ghs_')) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid incremental base request' });
    try {
      const result = await lookup.read({
        runId: parsed.data.runId, executionAttempt: parsed.data.executionAttempt, workerTokenDigest: sha256(token),
      });
      if (result.status === 'unauthorized') return response.status(403).json({ error: 'Worker is not authorized for this run' });
      return response.status(200).json({
        version: INCREMENTAL_BASE_RESPONSE_VERSION, runId: parsed.data.runId, maxAgeMs: result.maxAgeMs, prior: result.prior,
      });
    } catch {
      logger.warn('Incremental base lookup unavailable', { reason: 'persistence_unavailable', runId: parsed.data.runId });
      return response.status(503).json({ error: 'Incremental base lookup is temporarily unavailable' });
    }
  };
}
