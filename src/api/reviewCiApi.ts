import { Router } from 'express';
import { z } from 'zod';
import type { ReviewCiOidcVerifier } from '../auth/reviewCiOidc';
import type { ReviewCiService } from '../review/reviewCiService';
import { reviewCiRequestEventSchema } from '../review/reviewCi';

const wake = z.object({ schema_version: z.literal('review-yeti-ci-wake.v1'), validation_request_id: z.string().uuid() }).strict();
const event = z.union([reviewCiRequestEventSchema, wake]);
const claim = z.object({ requestId: z.string().uuid(), epoch: z.number().int().positive().safe() }).strict();
export interface ReviewCiRouterOptions {
  verifier: Pick<ReviewCiOidcVerifier, 'verify'>;
  service: Pick<ReviewCiService, 'wake' | 'claim'>;
}
export function createReviewCiRouter(options: ReviewCiRouterOptions): Router {
  const router = Router();
  router.post('/event', async (request, response) => {
    const parsed = event.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid Review CI event' });
    const token = /^Bearer ([^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1];
    if (!token) return response.status(401).json({ error: 'GitHub Actions OIDC bearer is required' });
    let caller;
    try {
      caller = await options.verifier.verify(token, 'relay');
      if ('repository_id' in parsed.data && (parsed.data.repository_id !== caller.repository.repositoryId
        || parsed.data.repository !== `${caller.repository.owner}/${caller.repository.repo}`)) throw new Error();
    } catch { return response.status(403).json({ error: 'Review CI event is not authorized' }); }
    try {
      const status = await options.service.wake(parsed.data.validation_request_id, caller);
      return response.status(202).json({ version: 'ReviewCiWake.v1', status });
    } catch { return response.status(503).json({ error: 'Review CI reconciliation is temporarily unavailable' }); }
  });
  router.post('/claim', async (request, response) => {
    const parsed = claim.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid Review CI execution claim' });
    const token = /^Bearer ([^\s]+)$/iu.exec(request.header('authorization') ?? '')?.[1];
    if (!token) return response.status(401).json({ error: 'GitHub Actions OIDC bearer is required' });
    let caller;
    try { caller = await options.verifier.verify(token, 'validation'); }
    catch { return response.status(403).json({ error: 'Review CI execution is not authorized' }); }
    try {
      const result = await options.service.claim(parsed.data.requestId, parsed.data.epoch, caller);
      return result ? response.status(200).json(result) : response.status(409).json({ error: 'Review CI execution claim is not current' });
    } catch { return response.status(503).json({ error: 'Review CI execution claim is temporarily unavailable' }); }
  });
  return router;
}
