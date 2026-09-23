import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  type GitHubActionsOidcClaims,
  type GitHubActionsOidcPolicy,
} from '../auth/githubActionsOidc';
import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import {
  workerTerminalFailureSchema,
  workerTerminalSuccessSchema,
  type WorkerCompletionProof,
  type WorkerTerminalFailure,
  type WorkerTerminalSuccess,
} from '../review/workerCompletion';
import { buildReviewRunIdentity } from '../review/reviewAdmission';
import {
  actionDispatchRequestSchema,
  actionDispatchDigestInput,
  assertActionDispatchMatchesClaims,
  type ActionDispatchCallerKind,
} from '../review/actionDispatch';
import { sha256 } from '../review/reviewCore';
import { isCentralRefreshAuthorized } from '../review/reviewRecoveryPolicy';
import { requeueRecoverableIncompletePanelFailure } from '../review/recoverablePanelRetry';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import { logger } from '../utils/logger';
import {
  parseWorkerReviewCompletion, parseWorkerReviewEvidence, workerReviewCompletionDigest, workerReviewEvidenceDigest,
  type WorkerReviewCompletion, type WorkerReviewEvidence,
} from '../review/workerReviewCompletion';
import type { WorkerCompletionStore } from '../persistence/workerCompletionStore';
import type { WorkerCompletionVerifier, AuthoritativeReviewAdmission, AuthoritativeReviewCompletion } from '../review/authoritativeServiceContracts';
import { ReviewGenerationConflictError } from '../review/reviewRun';
import {
  isDeterministicCompletionFailure,
  isWorkerCompletionPersistenceError,
  unknownWorkerCompletionPersistenceStage,
} from '../review/workerCompletionPersistenceError';
export { createWorkerCompletionVerifier, type WorkerCompletionVerifier } from '../review/authoritativeServiceContracts';

function constantTimeDigestEqual(expected: unknown, actual: string): boolean {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || !/^[a-f0-9]{64}$/u.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

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
  /** Exact service-owned external targets admitted through the trusted central workflow. */
  centralExternalRepositories?: ReadonlyMap<string, number>;
  /** Service-owned finite pilot allowlist; callers cannot opt themselves in or out. */
  authoritativePublishing?: AuthoritativeReviewAdmission;
  workerCompletion?: {
    verifier: WorkerCompletionVerifier;
    repository: Pick<ReviewDispatchRepository, 'markWorkerFailure' | 'markWorkerSuccess' | 'authorizeWorkerEvidence'
      | 'admit' | 'readRunRetryContext'>;
    /** Where review evidence (WorkerReviewEvidence.v1, or a terminal success's
     * optional result from older workers) is kept. */
    evidence?: WorkerCompletionStore;
  };
  authoritativeWorkerCompletion?: AuthoritativeReviewCompletion;
  runStatusRepository?: Pick<ReviewDispatchRepository, 'getRunStatus'>;
  now?: () => number;
}

/** Shape the terminal success's result as the same WorkerReviewCompletion.v1 the
 * authoritative path stores, so one table and one reader serve both paths, and
 * validate it with that contract's bounds (personas, findings, 1 MB). */
async function persistTerminalSuccessEvidence(evidence: WorkerCompletionStore, event: WorkerTerminalSuccess): Promise<void> {
  try {
    const { checkId: _checkId, result, ...coordinates } = event;
    const completion = parseWorkerReviewCompletion({
      ...coordinates, version: 'WorkerReviewCompletion.v1', result,
    });
    await evidence.put({
      runId: completion.runId,
      executionAttempt: completion.executionAttempt,
      contentDigest: workerReviewCompletionDigest(completion),
      payload: completion,
    });
  } catch (error) {
    logger.warn('Terminal success carried a review result that could not be kept', {
      reason: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : 'invalid_or_unpersistable',
      runId: event.runId,
      executionAttempt: event.executionAttempt,
    });
  }
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
    let claims: GitHubActionsOidcClaims;
    let callerKind: ActionDispatchCallerKind;
    try {
      claims = await options.verifier.verify(token);
      callerKind = assertActionDispatchMatchesClaims(
        dispatch,
        claims,
        options.centralExternalRepositories,
      );
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
    if (options.requireExpectedGeneration === true
      && callerKind === 'central'
      && dispatch.publishMode === 'app-gate'
      && dispatch.expectedGeneration === undefined) {
      return rejectInvalidDispatch(response, ['expectedGeneration']);
    }

    // A refresh is a privileged replacement of an exact worker generation. An
    // event name alone is not proof that the central workflow issued it: require
    // the OIDC workflow identities, bind the request to those claims, and apply
    // the verifier's explicit allowlist.
    const centralRefreshAuthorized = isCentralRefreshAuthorized(dispatch, claims, options.verifier.policy);

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
        centralActionDispatch: callerKind === 'central',
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
      } catch (error) {
        const persistenceError = isWorkerCompletionPersistenceError(error) ? error : undefined;
        const reason = persistenceError?.reason;
        // REL-1056: a DETERMINISTIC contract failure must not be reported as a
        // transient one. It previously returned 503 `persistence_unavailable`,
        // which tells the worker to retry a condition that can never succeed —
        // so a finished review was retried until its Job failed and the review
        // was thrown away. Retrying cannot change any of these outcomes, so they
        // are reported as a contract failure (422) with a bounded reason class.
        // Only genuinely transient failures keep the retryable 503.
        const deterministic = isDeterministicCompletionFailure(reason);
        logger.error('Failed to persist authoritative worker completion', {
          reason: deterministic ? 'completion_contract_rejected' : 'persistence_unavailable',
          stage: persistenceError?.stage ?? unknownWorkerCompletionPersistenceStage,
          ...(persistenceError?.substage ? { substage: persistenceError.substage } : {}),
          ...(reason ? { completionReason: reason } : {}),
          runId: event.runId,
        });
        if (deterministic) {
          return response.status(422).json({
            error: 'Worker review completion conflicts with the trusted review contract',
            reason,
          });
        }
        return response.status(503).json({ error: 'Worker review completion could not be persisted' });
      }
    }
    if (request.body?.version === 'WorkerReviewEvidence.v1') {
      let event: WorkerReviewEvidence;
      try { event = parseWorkerReviewEvidence(request.body); }
      catch { return response.status(400).json({ error: 'Invalid worker review evidence' }); }
      const completion = options.workerCompletion;
      if (!completion) return response.status(503).json({ error: 'Worker completion is not configured' });
      if (!completion.evidence) return response.status(503).json({ error: 'Worker review evidence is not configured' });
      let proof: WorkerCompletionProof;
      try { proof = await completion.verifier.verify(token, event); }
      catch { return response.status(403).json({ error: 'Worker completion is not authorized' }); }
      try {
        const authorization = await completion.repository.authorizeWorkerEvidence(event, proof);
        if (authorization.status === 'unauthorized') return response.status(403).json({ error: 'Worker completion is not authorized' });
        if (authorization.status === 'ignored') return response.status(409).json({ error: 'Worker completion conflicts with durable state' });
        const outcome = await completion.evidence.put({
          runId: event.runId,
          executionAttempt: event.executionAttempt,
          contentDigest: workerReviewEvidenceDigest(event),
          payload: event,
        });
        return response.status(200).json({ version: 'WorkerReviewEvidenceAccepted.v1', runId: event.runId, status: outcome });
      } catch {
        logger.error('Failed to persist worker review evidence', { reason: 'persistence_unavailable', runId: event.runId });
        return response.status(503).json({ error: 'Worker review evidence could not be persisted' });
      }
    }
    if (request.body?.version === 'WorkerTerminalSuccess.v1') {
      const parsed = workerTerminalSuccessSchema.safeParse(request.body);
      if (!parsed.success) return response.status(400).json({ error: 'Invalid worker terminal success' });
      const event: WorkerTerminalSuccess = parsed.data;
      const completion = options.workerCompletion;
      if (!completion) return response.status(503).json({ error: 'Worker completion is not configured' });
      let proof: WorkerCompletionProof;
      try { proof = await completion.verifier.verify(token, event); }
      catch { return response.status(403).json({ error: 'Worker completion is not authorized' }); }
      try {
        const transition = await completion.repository.markWorkerSuccess(event, proof, now());
        if (transition.status === 'unauthorized') {
          return response.status(403).json({ error: 'Worker completion is not authorized' });
        }
        if (transition.status === 'conflict') {
          return response.status(409).json({ error: 'Worker completion conflicts with recorded evidence' });
        }
        if (transition.status === 'ignored') {
          return response.status(409).json({ error: 'Worker completion conflicts with durable state' });
        }
        // The check is already published and the lifecycle transition committed.
        // Keeping the evidence behind it must never change that answer: a bad or
        // unpersistable result is logged and dropped, never a retry trigger.
        if (event.result !== undefined && completion.evidence) {
          await persistTerminalSuccessEvidence(completion.evidence, event);
        }
        return response.status(200).json({
          version: 'WorkerTerminalSuccessAccepted.v1',
          runId: transition.runId,
          status: transition.status,
        });
      } catch {
        logger.error('Failed to persist worker terminal success callback', {
          reason: 'persistence_unavailable',
          runId: event.runId,
        });
        return response.status(503).json({ error: 'Worker terminal success could not be persisted' });
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
      const failedAt = now();
      const transition = await completion.repository.markWorkerFailure(event, proof, failedAt);
      if (transition.status === 'unauthorized') {
        return response.status(403).json({ error: 'Worker completion is not authorized' });
      }
      // The bounded automatic recoverable-panel retry (REL-620) is orchestrated
      // here, not inside the repository: this handler owns `markWorkerFailure`
      // and is the one caller allowed to inherit the auto-requeue behaviour. A
      // failed re-admission is swallowed and logged inside the service itself,
      // so it can never turn an already-durable failure transition into a
      // completion-callback error.
      if (transition.status === 'failed') {
        await requeueRecoverableIncompletePanelFailure({
          input: event, now: failedAt, repository: completion.repository, logger,
        });
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

  const handleRunStatus = async (request: Request, response: Response) => {
    const token = bearerToken(request);
    if (!token) return response.status(401).json({ error: 'Bearer token is required' });

    const runId = String(request.params.runId || request.query.runId || '').trim();
    const attemptStr = request.params.attempt || request.query.attempt;
    const attempt = Number(attemptStr !== undefined ? attemptStr : 1);
    if (!runId || !Number.isSafeInteger(attempt) || attempt < 1) {
      return response.status(400).json({ error: 'Invalid run ID or execution attempt' });
    }

    const repository = options.runStatusRepository || (options.workerCompletion?.repository as any);
    if (!repository || typeof repository.getRunStatus !== 'function') {
      return response.status(503).json({ error: 'Run status lookup is not configured' });
    }

    try {
      const status = await repository.getRunStatus(runId, attempt);
      if (!status) {
        return response.status(404).json({ error: 'Run not found' });
      }

      const tokenDigest = sha256(token);
      if (!status.workerTokenDigest || !constantTimeDigestEqual(status.workerTokenDigest, tokenDigest)) {
        return response.status(401).json({ error: 'Unauthorized' });
      }

      return response.status(200).json({
        current: status.current,
        status: status.status,
        cancelRequested: status.cancelRequested,
        cancelReason: status.cancelReason,
        currentHeadSha: status.currentHeadSha,
        isCurrentHead: status.isCurrentHead,
      });
    } catch (err) {
      logger.error('Failed to get run status', {
        runId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      return response.status(500).json({ error: 'Failed to retrieve run status' });
    }
  };

  router.get('/runs/:runId/attempts/:attempt/status', handleRunStatus);
  router.get('/status', handleRunStatus);

  return router;
}
