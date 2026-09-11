import { Router, type Request, type Response } from 'express';
import {
  isAllowlistedWorkflowRef,
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcPolicy,
} from '../auth/githubActionsOidc';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import {
  workerTerminalFailureSchema,
  type WorkerCompletionProof,
  type WorkerTerminalFailure,
} from '../review/workerCompletion';
import { buildReviewRunIdentity } from '../review/reviewAdmission';
import {
  actionDispatchRequestSchema,
  actionDispatchDigestInput,
  assertActionDispatchMatchesClaims,
} from '../review/actionDispatch';
import { sha256 } from '../review/reviewCore';
import {
  CENTRAL_REVIEW_REPOSITORY,
  CENTRAL_REVIEW_WORKFLOW_REF,
} from '../review/reviewCheckIdentity';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import { logger } from '../utils/logger';
import { parseWorkerReviewCompletion, type WorkerReviewCompletion } from '../review/workerReviewCompletion';
import type { WorkerCompletionVerifier, AuthoritativeReviewAdmission, AuthoritativeReviewCompletion } from '../review/authoritativeServiceContracts';
import { ReviewGenerationConflictError } from '../review/reviewRun';
export { createWorkerCompletionVerifier, type WorkerCompletionVerifier } from '../review/authoritativeServiceContracts';

export interface ActionOidcVerifier {
  verify(token: string): Promise<GitHubActionsOidcClaims>;
  /** The verified token policy; required to authorize central refresh forwarding. */
  policy?: Pick<GitHubActionsOidcPolicy, 'workflowRefs'>;
}

export interface ActionDispatchRouterOptions {
  verifier: ActionOidcVerifier;
  admission: Pick<ReviewDispatchRepository, 'admit'>;
  resolveInstallationId(owner: string, repo: string): Promise<number>;
  allowAppGate?: boolean;
  /** Rollout fence: require the central App ledger's exact one-based generation. */
  requireExpectedGeneration?: boolean;
  /** Service-owned finite pilot allowlist; callers cannot opt themselves in or out. */
  authoritativePublishing?: AuthoritativeReviewAdmission;
  workerCompletion?: {
    verifier: WorkerCompletionVerifier;
    repository: Pick<ReviewDispatchRepository, 'markWorkerFailure'>;
  };
  authoritativeWorkerCompletion?: AuthoritativeReviewCompletion;
  now?: () => number;
}

function bearerToken(request: Request): string | null {
  const header = request.header('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/iu.exec(header);
  return match?.[1] || null;
}

function rejectInvalidDispatch(response: Response, invalidFields: string[]) {
  logger.warn('Rejected invalid Action dispatch request', {
    reason: 'invalid_action_dispatch_request',
    invalidFields,
  });
  return response.status(400).json(invalidFields.includes('expectedGeneration')
    ? { error: 'Invalid Action dispatch request', invalidFields: ['expectedGeneration'] }
    : { error: 'Invalid Action dispatch request' });
}

export function createActionDispatchRouter(options: ActionDispatchRouterOptions): Router {
  const router = Router();
  const now = options.now || Date.now;
  const authoritative = options.authoritativePublishing;
  const authoritativeRepositories = new Set(authoritative?.repositoryIds || []);
  if (authoritative && (!Number.isSafeInteger(authoritative.expectedAppId) || authoritative.expectedAppId <= 0
    || authoritativeRepositories.size === 0 || authoritativeRepositories.size > 100
    || authoritativeRepositories.size !== authoritative.repositoryIds.length
    || [...authoritativeRepositories].some((id) => !Number.isSafeInteger(id) || id <= 0))) {
    throw new Error('Invalid authoritative review admission configuration');
  }

  router.post('/action', async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token) return response.status(401).json({ error: 'GitHub Actions OIDC bearer token is required' });

    const parsed = actionDispatchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Return only schema field names, never rejected values. This keeps the
      // runner's bounded failure detail actionable without reflecting request
      // data or verifier internals into logs.
      const invalidFields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] || 'request')))].sort();
      return rejectInvalidDispatch(response, invalidFields);
    }
    const dispatch = parsed.data;
    if (options.requireExpectedGeneration === true
      && dispatch.publishMode === 'app-gate'
      && dispatch.caller.eventName === 'repository_dispatch'
      && dispatch.expectedGeneration === undefined) {
      return rejectInvalidDispatch(response, ['expectedGeneration']);
    }

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

    // A refresh is a privileged replacement of an exact worker generation. A
    // repository_dispatch event name alone is not proof that the central
    // workflow issued it: require the OIDC job_workflow_ref itself, bind the
    // request to that claim, and apply the verifier's explicit allowlist.
    const centralRefreshAuthorized = dispatch.publishMode === 'app-gate'
      && dispatch.caller.eventName === 'repository_dispatch'
      && dispatch.refreshRequested === true
      && claims.repository === CENTRAL_REVIEW_REPOSITORY
      && claims.job_workflow_ref === CENTRAL_REVIEW_WORKFLOW_REF
      && dispatch.caller.workflowRef === CENTRAL_REVIEW_WORKFLOW_REF
      && options.verifier.policy !== undefined
      && isAllowlistedWorkflowRef(options.verifier.policy, CENTRAL_REVIEW_WORKFLOW_REF);

    const receivedAt = now();
    const requestedAt = Date.parse(dispatch.requestedAt);
    if (!Number.isFinite(requestedAt) || Math.abs(receivedAt - requestedAt) > 10 * 60_000) {
      return response.status(400).json({ error: 'Action dispatch request timestamp is outside the accepted window' });
    }
    if (authoritative?.acceptNewRequests === false && dispatch.publishMode === 'app-gate'
      && authoritativeRepositories.has(dispatch.repositoryId)) {
      return response.status(503).json({ error: 'Authoritative review admission is paused' });
    }

    try {
      const installationId = await options.resolveInstallationId(dispatch.owner, dispatch.repo);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('GitHub App installation could not be resolved');
      const resolved = authoritative && dispatch.publishMode === 'app-gate' && authoritativeRepositories.has(dispatch.repositoryId)
        ? await authoritative.resolver.resolve({ repositoryId: dispatch.repositoryId,
          owner: dispatch.owner, repo: dispatch.repo, prNumber: dispatch.prNumber,
          headSha: dispatch.headSha, baseSha: dispatch.baseSha }) : undefined;
      const admission = await options.admission.admit({
        deliveryId: dispatch.deliveryId,
        eventName: dispatch.caller.eventName,
        repositoryId: dispatch.repositoryId,
        installationId,
        receivedAt,
        terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
        payloadDigest: sha256(actionDispatchDigestInput(dispatch)),
        publicationMode: dispatch.publishMode,
        // Only the central repository-dispatch boundary may carry the explicit
        // refresh request. OIDC proves the workflow identity above; the
        // repository persists the retry only after its own state/evidence gate.
        ...(centralRefreshAuthorized ? {
          retryRequested: true,
          retryAfterExecutionAttempt: dispatch.refreshExecutionAttempt,
        } : {}),
        ...(dispatch.expectedGeneration === undefined ? {} : { expectedGeneration: dispatch.expectedGeneration }),
        identity: resolved?.identity || buildReviewRunIdentity({
          owner: dispatch.owner,
          repo: dispatch.repo,
          prNumber: dispatch.prNumber,
          headSha: dispatch.headSha,
          baseSha: dispatch.baseSha,
        }),
        ...(resolved && authoritative ? {
          effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
          authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
        } : {}),
      });
      return response.status(202).json({
        version: 'ActionDispatchAccepted.v1',
        status: admission.status,
        runId: admission.run.runId,
      });
    } catch (error) {
      if (error instanceof ReviewGenerationConflictError) {
        logger.warn('Rejected mismatched review generation', {
          reason: 'review_generation_conflict',
          repositoryId: dispatch.repositoryId,
          expectedGeneration: error.expectedGeneration,
          durableGeneration: error.durableGeneration,
        });
        return response.status(409).json({
          error: 'Expected review generation does not match durable service state',
          expectedGeneration: error.expectedGeneration,
          durableGeneration: error.durableGeneration,
        });
      }
      logger.error('Failed to durably admit GitHub Actions dispatch', {
        reason: 'admission_unavailable',
        repositoryId: dispatch.repositoryId,
      });
      return response.status(503).json({ error: 'Review dispatch admission is temporarily unavailable' });
    }
  });

  router.post('/completion', async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    if (request.body?.version === 'WorkerReviewCompletion.v1') {
      let event: WorkerReviewCompletion;
      try { event = parseWorkerReviewCompletion(request.body); }
      catch { return response.status(400).json({ error: 'Invalid worker review completion' }); }
      const completion = options.authoritativeWorkerCompletion;
      if (!completion) return response.status(503).json({ error: 'Authoritative worker completion is not configured' });
      let proof: WorkerCompletionProof;
      try { proof = await completion.verifier.verify(token, event); }
      catch { return response.status(403).json({ error: 'Worker completion is not authorized' }); }
      try {
        const status = await completion.repository.recordWorkerResult(event, proof, completion.resolve, now());
        if (status === 'unauthorized') return response.status(403).json({ error: 'Worker completion is not authorized' });
        if (status === 'conflict') return response.status(409).json({ error: 'Worker completion conflicts with recorded evidence' });
        return response.status(200).json({ version: 'WorkerReviewCompletionAccepted.v1', runId: event.runId, status });
      } catch {
        logger.error('Failed to persist authoritative worker completion', { reason: 'persistence_unavailable', runId: event.runId });
        return response.status(503).json({ error: 'Worker review completion could not be persisted' });
      }
    }
    const parsed = workerTerminalFailureSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid worker terminal failure' });
    const event = parsed.data;
    const completion = options.workerCompletion;
    if (!completion) return response.status(503).json({ error: 'Worker completion is not configured' });

    let proof: WorkerCompletionProof;
    try {
      proof = await completion.verifier.verify(token, event);
    } catch {
      logger.warn('Rejected worker terminal failure callback', {
        reason: 'worker_completion_credential_rejected',
        runId: event.runId,
      });
      return response.status(403).json({ error: 'Worker completion is not authorized' });
    }

    try {
      const transition = await completion.repository.markWorkerFailure(event, proof, now());
      if (transition.status === 'unauthorized') {
        return response.status(403).json({ error: 'Worker completion is not authorized' });
      }
      return response.status(200).json({
        version: 'WorkerTerminalFailureAccepted.v1',
        runId: transition.runId,
        status: transition.status,
      });
    } catch (error) {
      logger.error('Failed to persist worker terminal failure callback', {
        reason: 'persistence_unavailable',
        runId: event.runId,
      });
      return response.status(503).json({ error: 'Worker terminal failure could not be persisted' });
    }
  });

  return router;
}
