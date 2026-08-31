import { Router, type Request, type Response } from 'express';
import type { GitHubActionsOidcClaims } from '../auth/githubActionsOidc';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import { buildReviewRunIdentity } from '../review/reviewAdmission';
import {
  actionDispatchRequestSchema,
  actionDispatchDigestInput,
  assertActionDispatchMatchesClaims,
} from '../review/actionDispatch';
import { sha256 } from '../review/reviewCore';
import { logger } from '../utils/logger';

export interface ActionOidcVerifier {
  verify(token: string): Promise<GitHubActionsOidcClaims>;
}

export interface ActionDispatchRouterOptions {
  verifier: ActionOidcVerifier;
  admission: Pick<ReviewDispatchRepository, 'admit'>;
  resolveInstallationId(owner: string, repo: string): Promise<number>;
  allowAppGate?: boolean;
  now?: () => number;
}

function bearerToken(request: Request): string | null {
  const header = request.header('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
  return match?.[1] || null;
}

export function createActionDispatchRouter(options: ActionDispatchRouterOptions): Router {
  const router = Router();
  const now = options.now || Date.now;

  router.post('/action', async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token) return response.status(401).json({ error: 'GitHub Actions OIDC bearer token is required' });

    const parsed = actionDispatchRequestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid Action dispatch request' });
    const dispatch = parsed.data;

    let claims: GitHubActionsOidcClaims;
    try {
      claims = await options.verifier.verify(token);
      assertActionDispatchMatchesClaims(dispatch, claims);
      if (dispatch.publishMode === 'app-gate' && options.allowAppGate !== true) {
        throw new Error('App-gate publication is not enabled for Action dispatch');
      }
    } catch (error) {
      logger.warn('Rejected GitHub Actions OIDC dispatch', {
        error: error instanceof Error ? error.message : String(error),
        repositoryId: dispatch.repositoryId,
      });
      return response.status(403).json({ error: 'Action dispatch is not authorized' });
    }

    const receivedAt = now();
    const requestedAt = Date.parse(dispatch.requestedAt);
    if (!Number.isFinite(requestedAt) || Math.abs(receivedAt - requestedAt) > 10 * 60_000) {
      return response.status(400).json({ error: 'Action dispatch request timestamp is outside the accepted window' });
    }

    try {
      const installationId = await options.resolveInstallationId(dispatch.owner, dispatch.repo);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('GitHub App installation could not be resolved');
      const admission = await options.admission.admit({
        deliveryId: dispatch.deliveryId,
        eventName: dispatch.caller.eventName,
        repositoryId: dispatch.repositoryId,
        installationId,
        receivedAt,
        terminalDeadline: receivedAt + 900_000,
        payloadDigest: sha256(actionDispatchDigestInput(dispatch)),
        publicationMode: dispatch.publishMode,
        identity: buildReviewRunIdentity({
          owner: dispatch.owner,
          repo: dispatch.repo,
          prNumber: dispatch.prNumber,
          headSha: dispatch.headSha,
          baseSha: dispatch.baseSha,
        }),
      });
      return response.status(202).json({
        version: 'ActionDispatchAccepted.v1',
        status: admission.status,
        runId: admission.run.runId,
      });
    } catch (error) {
      logger.error('Failed to durably admit GitHub Actions dispatch', {
        error: error instanceof Error ? error.message : String(error),
        repositoryId: dispatch.repositoryId,
      });
      return response.status(503).json({ error: 'Review dispatch admission is temporarily unavailable' });
    }
  });

  return router;
}
