import type { Env, ReviewRunSpec } from '../types.js';
import {
  operatorPassthroughActionDispatchTargets,
  publishOperatorPassthroughForTarget,
} from '../operatorPassthroughPublisher.js';
import {
  verifyGitHubActionsOidc,
  assertActionDispatchMatchesClaims,
  type GitHubActionsOidcClaims,
  type VerifyOidcOptions,
} from '../auth/oidcVerifier.js';
import { TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER } from '../auth/trustedCentralActionDispatch.js';
import { isPilotRepository, registerPendingRunForPR } from '../worker.js';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const RUN_ID_DIGITS_PATTERN = /^\d+$/u;
const SUPPORTED_EVENTS = new Set([
  'workflow_dispatch',
  'pull_request_target',
  'pull_request',
  'repository_dispatch',
]);

export interface ActionDispatchRequest {
  version: 'ActionDispatch.v1';
  deliveryId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  actionSha: string;
  publishMode: 'disabled' | 'app-gate';
  requestedAt: string;
  caller: {
    runId: string;
    runAttempt: number;
    eventName: 'workflow_dispatch' | 'pull_request_target' | 'pull_request' | 'repository_dispatch';
    workflowRef?: string;
    workflowSha?: string;
  };
  policy?: {
    personas?: string;
    maxInvestigationTurns?: number;
    laneCallBudget?: number;
    skills?: unknown;
    knowledge?: unknown;
    metrics?: unknown;
    telemetry?: unknown;
    retryAnalysis?: unknown;
    retroAnalysis?: unknown;
  };
  refreshRequested?: boolean;
  refreshExecutionAttempt?: number;
  expectedGeneration?: number;
  incompleteP2Recovery?: boolean;
  qualificationRuntimeImageDigest?: string;
  qualificationDispatchOriginSha256?: string;
  checkId?: number;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors: string[];
}

export function validateActionDispatchRequest(body: any): ValidationResult<ActionDispatchRequest> {
  const errors: string[] = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['request'] };
  }

  if (body.version !== 'ActionDispatch.v1') {
    errors.push('version');
  }

  if (
    typeof body.deliveryId !== 'string' ||
    body.deliveryId.length < 1 ||
    body.deliveryId.length > 512
  ) {
    errors.push('deliveryId');
  }

  if (!Number.isSafeInteger(body.repositoryId) || body.repositoryId <= 0) {
    errors.push('repositoryId');
  }

  if (typeof body.owner !== 'string' || !NAME_PATTERN.test(body.owner)) {
    errors.push('owner');
  }

  if (typeof body.repo !== 'string' || !NAME_PATTERN.test(body.repo)) {
    errors.push('repo');
  }

  if (!Number.isSafeInteger(body.prNumber) || body.prNumber <= 0) {
    errors.push('prNumber');
  }

  if (typeof body.headSha !== 'string' || !SHA_PATTERN.test(body.headSha.toLowerCase())) {
    errors.push('headSha');
  }

  if (typeof body.baseSha !== 'string' || !SHA_PATTERN.test(body.baseSha.toLowerCase())) {
    errors.push('baseSha');
  }

  if (typeof body.actionSha !== 'string' || !SHA_PATTERN.test(body.actionSha.toLowerCase())) {
    errors.push('actionSha');
  }

  if (body.publishMode !== 'disabled' && body.publishMode !== 'app-gate') {
    errors.push('publishMode');
  }

  if (typeof body.requestedAt !== 'string' || isNaN(Date.parse(body.requestedAt))) {
    errors.push('requestedAt');
  }

  if (!body.caller || typeof body.caller !== 'object' || Array.isArray(body.caller)) {
    errors.push('caller');
  } else {
    if (
      typeof body.caller.runId !== 'string' ||
      !RUN_ID_DIGITS_PATTERN.test(body.caller.runId)
    ) {
      errors.push('caller.runId');
    }
    if (!Number.isSafeInteger(body.caller.runAttempt) || body.caller.runAttempt <= 0) {
      errors.push('caller.runAttempt');
    }
    if (typeof body.caller.eventName !== 'string' || !SUPPORTED_EVENTS.has(body.caller.eventName)) {
      errors.push('caller.eventName');
    }
    if (
      body.caller.workflowSha !== undefined &&
      (typeof body.caller.workflowSha !== 'string' ||
        !SHA_PATTERN.test(body.caller.workflowSha.toLowerCase()))
    ) {
      errors.push('caller.workflowSha');
    }
  }

  if (body.expectedGeneration !== undefined) {
    if (!Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration <= 0) {
      errors.push('expectedGeneration');
    }
  }

  if (body.refreshExecutionAttempt !== undefined) {
    if (
      !Number.isSafeInteger(body.refreshExecutionAttempt) ||
      body.refreshExecutionAttempt <= 0
    ) {
      errors.push('refreshExecutionAttempt');
    }
  }

  if (body.refreshRequested === true && body.refreshExecutionAttempt === undefined) {
    errors.push('refreshExecutionAttempt');
  }

  if (body.incompleteP2Recovery === true) {
    if (
      body.refreshRequested !== true ||
      body.expectedGeneration === undefined ||
      body.expectedGeneration < 2 ||
      body.expectedGeneration > 3 ||
      body.refreshExecutionAttempt !== body.expectedGeneration - 1
    ) {
      errors.push('incompleteP2Recovery');
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors: errors.sort() };
  }

  return {
    valid: true,
    data: {
      ...body,
      headSha: body.headSha.toLowerCase(),
      baseSha: body.baseSha.toLowerCase(),
      actionSha: body.actionSha.toLowerCase(),
      caller: {
        ...body.caller,
        workflowSha: body.caller.workflowSha ? body.caller.workflowSha.toLowerCase() : undefined,
      },
    },
    errors: [],
  };
}

/**
 * Handles GitHub Actions OIDC Dispatch requests:
 * POST /api/dispatch/action or POST /action
 */
export async function handleActionDispatch(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  verifierOptions?: VerifyOidcOptions
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed: POST required', { status: 405 });
  }

  // 1. Extract Bearer token
  const authHeader =
    request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const tokenMatch = /^Bearer\s+([^\s]+)$/i.exec(authHeader);
  if (!tokenMatch) {
    return Response.json(
      { error: 'GitHub Actions OIDC bearer token is required' },
      { status: 401 }
    );
  }
  const token = tokenMatch[1];

  // 2. Read and parse body
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  // 3. Schema validation
  const validation = validateActionDispatchRequest(body);
  if (!validation.valid || !validation.data) {
    return Response.json(
      {
        error: 'Invalid Action dispatch request',
        invalidFields: validation.errors,
      },
      { status: 400 }
    );
  }

  const dispatch = validation.data;

  // 4. Verify OIDC token and match claims
  let claims: GitHubActionsOidcClaims;
  let callerKind: 'direct' | 'central';
  try {
    claims = await verifyGitHubActionsOidc(token, verifierOptions);
    const centralTargets = claims.repository.toLowerCase() === TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER.repository
      ? operatorPassthroughActionDispatchTargets(env)
      : undefined;
    callerKind = assertActionDispatchMatchesClaims(dispatch, claims, centralTargets);
  } catch (err: any) {
    console.warn('Rejected GitHub Actions OIDC dispatch:', err?.message || err);
    return Response.json({ error: 'Action dispatch is not authorized' }, { status: 403 });
  }

  // 5. Freshness check: timestamp must be within +/- 10 minutes
  const receivedAt = Date.now();
  const requestedAt = Date.parse(dispatch.requestedAt);
  if (!Number.isFinite(requestedAt) || Math.abs(receivedAt - requestedAt) > 10 * 60_000) {
    return Response.json(
      { error: 'Action dispatch request timestamp is outside the accepted window' },
      { status: 400 }
    );
  }

  const repoFullName = `${dispatch.owner}/${dispatch.repo}`;
  const repoKey = repoFullName.toLowerCase();

  // 6. Pilot repository allowlist
  if (!isPilotRepository(repoFullName, env.PILOT_REPOSITORIES)) {
    return Response.json(
      { error: 'Action dispatch is not authorized for repository' },
      { status: 403 }
    );
  }

  // 7. Operator Global Passthrough Mode
  const passthroughEnabled = env.OPERATOR_GLOBAL_PASSTHROUGH === 'true';
  if (passthroughEnabled) {
    const publication = await publishOperatorPassthroughForTarget(env, {
      owner: dispatch.owner,
      repo: dispatch.repo,
      prNumber: dispatch.prNumber,
    }, {}, { headSha: dispatch.headSha, baseSha: dispatch.baseSha });
    const isPublished = publication.status === 'succeeded' && publication.mergeEligible === true
      && publication.publicationReceiptAvailable === true;
    const mergeEligible = isPublished;
    const passthroughReceipt = {
      version: 'ActionDispatchPassthrough.v1',
      status: 'passthrough',
      reason: 'operator_global_passthrough',
      reviewStarted: publication.reviewStarted,
      candidateState: publication.candidateState,
      verdict: publication.verdict,
      expectedLanes: publication.expectedLanes,
      completedLanes: publication.completedLanes,
      publicationId: isPublished ? publication.publicationId : null,
      auditDigest: isPublished ? publication.auditDigest : null,
      publicationState: isPublished ? 'published' : 'unavailable',
      publicationReceiptAvailable: publication.publicationReceiptAvailable,
      reviewCheckId: isPublished ? publication.workerCheckId : null,
      gateCheckId: isPublished ? publication.gateCheckId : null,
      mergeEligible,
      message: isPublished
        ? 'Operator pause published a current, durable App check pair. No semantic review ran; zero lanes were started.'
        : 'Operator pause publication is unavailable. No semantic review ran; protected merge eligibility is false.',
      deliveryId: dispatch.deliveryId,
      eventName: dispatch.caller.eventName,
      repositoryId: publication.repositoryId,
      owner: publication.owner,
      repo: publication.repo,
      prNumber: publication.prNumber,
      headSha: publication.headSha,
      baseSha: publication.baseSha,
      appId: publication.appId,
      policyDigest: publication.policyDigest,
      runId: publication.runId,
      errorCode: isPublished ? undefined : publication.errorCode,
      callerKind,
    } as const;

    return isPublished
      ? Response.json(passthroughReceipt, { status: 200 })
      : Response.json(passthroughReceipt, { status: 503 });
  }

  // 8. Normal Review Yeti Admission
  const runId = `run_${crypto.randomUUID().replace(/-/g, '')}`;

  // Register pending run with RepoGateDO
  await registerPendingRunForPR(env, repoKey, dispatch.prNumber, runId);

  // Trigger ReviewJobWorkflow
  const spec: ReviewRunSpec = {
    runId,
    owner: dispatch.owner,
    repo: dispatch.repo,
    prNumber: dispatch.prNumber,
    headSha: dispatch.headSha,
    baseSha: dispatch.baseSha,
    installationId: 0,
    publicationMode: dispatch.publishMode === 'app-gate' ? 'publishing' : 'disabled',
    thinkingEffort:
      dispatch.policy?.maxInvestigationTurns && dispatch.policy.maxInvestigationTurns > 10
        ? 'max'
        : undefined,
  };

  if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
    await env.REVIEW_JOB_WORKFLOW.create({
      id: runId,
      params: spec,
    });
  }

  // 9. Parallel Mode Fanout to DOKS Ingress (if active)
  if (env.PARALLEL_MODE !== 'false' && env.DOKS_FALLBACK_URL) {
    const fanoutPromise = fetch(`${env.DOKS_FALLBACK_URL}/api/dispatch/action`, {
      method: 'POST',
      headers: request.headers,
      body: rawBody,
    }).catch((err) => {
      console.error('DOKS action dispatch fanout error:', err);
    });

    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(fanoutPromise);
    }
  }

  // Return canonical ActionDispatchAccepted.v1 receipt
  return Response.json(
    {
      version: 'ActionDispatchAccepted.v1',
      status: 'accepted',
      runId,
    },
    { status: 202 }
  );
}
