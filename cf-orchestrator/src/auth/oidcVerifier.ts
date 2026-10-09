import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_ACTIONS_JWKS_URL = new URL('https://token.actions.githubusercontent.com/.well-known/jwks');
export const DEFAULT_ACCEPTED_AUDIENCES = ['review-yeti-doks-dispatch', 'review-yeti-edge-dispatch'];

export const CENTRAL_REVIEW_OWNER = 'review-yeti-ai';
export const CENTRAL_REVIEW_REPOSITORIES = new Set([
  'review-yeti-ai/review-yeti-action',
  'review-yeti-ai/review-yeti-bot',
]);

export interface GitHubActionsOidcClaims {
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  run_id: string;
  run_attempt: string;
  event_name: string;
  sha?: string;
  ref?: string;
  workflow_ref?: string;
  workflow_sha?: string;
  job_workflow_ref?: string;
  job_workflow_sha?: string;
  actor?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  sub?: string;
  [key: string]: unknown;
}

export interface VerifyOidcOptions {
  keySet?: JWTVerifyGetKey;
  audiences?: string[];
  clockToleranceSeconds?: number;
  maxTokenAge?: string;
}

let cachedJWKS: JWTVerifyGetKey | null = null;

export function getGitHubActionsJWKS(): JWTVerifyGetKey {
  if (!cachedJWKS) {
    cachedJWKS = createRemoteJWKSet(GITHUB_ACTIONS_JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 5_000,
    });
  }
  return cachedJWKS;
}

function requiredClaim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`GitHub Actions OIDC claim '${name}' is missing or invalid`);
  }
  return value.trim();
}

/**
 * Verifies a GitHub Actions OIDC token using Web Crypto and jose.
 * Validates issuer, audience, RS256 algorithm, expiry, and required claim fields.
 */
export async function verifyGitHubActionsOidc(
  token: string,
  options: VerifyOidcOptions = {}
): Promise<GitHubActionsOidcClaims> {
  if (!token || typeof token !== 'string') {
    throw new Error('OIDC token string is required');
  }

  const keySet = options.keySet || getGitHubActionsJWKS();
  const audiences = options.audiences || DEFAULT_ACCEPTED_AUDIENCES;

  const { payload } = await jwtVerify(token, keySet, {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    audience: audiences,
    algorithms: ['RS256'],
    clockTolerance: options.clockToleranceSeconds ?? 5,
    maxTokenAge: options.maxTokenAge ?? '10m',
  });

  const claims: GitHubActionsOidcClaims = {
    ...payload,
    repository: requiredClaim(payload, 'repository'),
    repository_id: requiredClaim(payload, 'repository_id'),
    repository_owner_id: requiredClaim(payload, 'repository_owner_id'),
    run_id: requiredClaim(payload, 'run_id'),
    run_attempt: requiredClaim(payload, 'run_attempt'),
    event_name: requiredClaim(payload, 'event_name'),
  };

  return claims;
}

export function expectedActionDeliveryId(request: {
  caller: { runId: string; runAttempt: number };
  repositoryId: number;
  prNumber: number;
  headSha: string;
}): string {
  return `actions:${request.caller.runId}:${request.caller.runAttempt}:${request.repositoryId}:${request.prNumber}:${request.headSha}`;
}

export interface ActionDispatchClaimSubject {
  deliveryId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  caller: {
    runId: string;
    runAttempt: number;
    eventName: string;
    workflowRef?: string;
    workflowSha?: string;
  };
}

/**
 * Asserts that the verified GitHub Actions OIDC claims match the dispatch request.
 * Enforces repository identity, caller run ID, attempt, event name, and delivery ID.
 * Returns 'direct' or 'central' caller kind.
 */
export function assertActionDispatchMatchesClaims(
  request: ActionDispatchClaimSubject,
  claims: GitHubActionsOidcClaims,
  centralExternalRepositories?: ReadonlyMap<string, number>
): 'direct' | 'central' {
  const repository = `${request.owner}/${request.repo}`;
  const configuredExternalId = centralExternalRepositories?.get(repository);
  if (configuredExternalId !== undefined && request.repositoryId !== configuredExternalId) {
    throw new Error('Action dispatch repository ID does not match configured external target');
  }

  const isDirect =
    repository.toLowerCase() === claims.repository.toLowerCase() &&
    String(request.repositoryId) === claims.repository_id;

  const isSupportedExternalTarget = configuredExternalId === request.repositoryId;
  const isCentralTarget =
    request.owner.toLowerCase() === CENTRAL_REVIEW_OWNER.toLowerCase() || isSupportedExternalTarget;

  const isCentralRepositoryDispatch = request.caller.eventName === 'repository_dispatch';
  const isCentralManualDispatch = request.caller.eventName === 'workflow_dispatch';

  const isCentral =
    (isCentralRepositoryDispatch || isCentralManualDispatch) &&
    CENTRAL_REVIEW_REPOSITORIES.has(claims.repository) &&
    isCentralTarget;

  const callerKind: 'direct' | 'central' | null = isCentral ? 'central' : isDirect ? 'direct' : null;

  if (callerKind === null) {
    throw new Error(
      `Action dispatch request repository (${repository}, ID: ${request.repositoryId}) does not match OIDC token claims (${claims.repository}, ID: ${claims.repository_id})`
    );
  }

  if (request.caller.runId !== claims.run_id) {
    throw new Error('Action dispatch caller.runId does not match OIDC run_id');
  }

  if (String(request.caller.runAttempt) !== String(claims.run_attempt)) {
    throw new Error('Action dispatch caller.runAttempt does not match OIDC run_attempt');
  }

  if (request.caller.eventName !== claims.event_name) {
    throw new Error('Action dispatch caller.eventName does not match OIDC event_name');
  }

  const expectedDelivery = expectedActionDeliveryId(request);
  if (request.deliveryId !== expectedDelivery) {
    throw new Error(
      `Action dispatch deliveryId does not match expected format (${expectedDelivery})`
    );
  }

  if (request.caller.workflowRef) {
    const refs = new Set([claims.workflow_ref, claims.job_workflow_ref].filter(Boolean));
    if (!refs.has(request.caller.workflowRef)) {
      throw new Error('Action dispatch workflowRef does not match verified GitHub OIDC claims');
    }
  }

  if (request.caller.workflowSha) {
    const shas = new Set([claims.workflow_sha, claims.job_workflow_sha].filter(Boolean));
    if (!shas.has(request.caller.workflowSha)) {
      throw new Error('Action dispatch workflowSha does not match verified GitHub OIDC claims');
    }
  }

  return callerKind;
}
