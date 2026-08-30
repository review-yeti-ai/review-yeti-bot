import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const REVIEW_DISPATCH_AUDIENCE = 'review-yeti-doks-dispatch';
export const GITHUB_ACTIONS_JWKS_URL = new URL('https://token.actions.githubusercontent.com/.well-known/jwks');

export interface GitHubActionsOidcClaims extends JWTPayload {
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  run_id: string;
  run_attempt: string;
  event_name: string;
  workflow_ref?: string;
  workflow_sha?: string;
  job_workflow_ref?: string;
  job_workflow_sha?: string;
}

export interface GitHubActionsOidcPolicy {
  repositoryIds: ReadonlySet<string>;
  ownerIds: ReadonlySet<string>;
  workflowRefs: ReadonlySet<string>;
  workflowShas: ReadonlySet<string>;
  allowedEvents: ReadonlySet<string>;
  allowAppGate: boolean;
}

export interface GitHubActionsOidcVerifierOptions {
  keySet?: JWTVerifyGetKey;
  policy: GitHubActionsOidcPolicy;
}

function requiredClaim(payload: JWTPayload, name: keyof GitHubActionsOidcClaims): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`GitHub Actions OIDC claim ${String(name)} is missing`);
  return value;
}

function csvSet(value: string | undefined, name: string): Set<string> {
  const values = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one explicit allowlisted value`);
  return new Set(values);
}

export function githubActionsOidcPolicyFromEnv(environment: NodeJS.ProcessEnv = process.env): GitHubActionsOidcPolicy {
  return {
    repositoryIds: csvSet(environment.ACTION_DISPATCH_REPOSITORY_IDS, 'ACTION_DISPATCH_REPOSITORY_IDS'),
    ownerIds: csvSet(environment.ACTION_DISPATCH_OWNER_IDS, 'ACTION_DISPATCH_OWNER_IDS'),
    workflowRefs: csvSet(environment.ACTION_DISPATCH_WORKFLOW_REFS, 'ACTION_DISPATCH_WORKFLOW_REFS'),
    workflowShas: csvSet(environment.ACTION_DISPATCH_WORKFLOW_SHAS, 'ACTION_DISPATCH_WORKFLOW_SHAS'),
    allowedEvents: new Set(['workflow_dispatch', 'pull_request_target', 'pull_request']),
    allowAppGate: environment.ACTION_DISPATCH_ALLOW_APP_GATE === 'true',
  };
}

export class GitHubActionsOidcVerifier {
  private readonly keySet: JWTVerifyGetKey;
  public readonly policy: GitHubActionsOidcPolicy;

  constructor(options: GitHubActionsOidcVerifierOptions) {
    this.keySet = options.keySet || createRemoteJWKSet(GITHUB_ACTIONS_JWKS_URL, {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 5_000,
    });
    this.policy = options.policy;
  }

  async verify(token: string): Promise<GitHubActionsOidcClaims> {
    const { payload } = await jwtVerify(token, this.keySet, {
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      audience: REVIEW_DISPATCH_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: 5,
      maxTokenAge: '10m',
    });

    const claims: GitHubActionsOidcClaims = {
      ...payload,
      repository: requiredClaim(payload, 'repository'),
      repository_id: requiredClaim(payload, 'repository_id'),
      repository_owner_id: requiredClaim(payload, 'repository_owner_id'),
      run_id: requiredClaim(payload, 'run_id'),
      run_attempt: requiredClaim(payload, 'run_attempt'),
      event_name: requiredClaim(payload, 'event_name'),
      ...(typeof payload.workflow_ref === 'string' ? { workflow_ref: payload.workflow_ref } : {}),
      ...(typeof payload.workflow_sha === 'string' ? { workflow_sha: payload.workflow_sha } : {}),
      ...(typeof payload.job_workflow_ref === 'string' ? { job_workflow_ref: payload.job_workflow_ref } : {}),
      ...(typeof payload.job_workflow_sha === 'string' ? { job_workflow_sha: payload.job_workflow_sha } : {}),
    };

    if (!this.policy.ownerIds.has(claims.repository_owner_id)) {
      throw new Error('GitHub Actions OIDC owner id is not allowlisted');
    }
    if (!this.policy.repositoryIds.has(claims.repository_id)) {
      throw new Error('GitHub Actions OIDC repository id is not allowlisted');
    }
    if (!this.policy.allowedEvents.has(claims.event_name)) {
      throw new Error('GitHub Actions OIDC event is not allowed');
    }

    const workflowRef = claims.job_workflow_ref || claims.workflow_ref;
    const workflowSha = claims.job_workflow_sha || claims.workflow_sha;
    if (!workflowRef || !workflowSha) {
      throw new Error('GitHub Actions OIDC token has no immutable workflow provenance');
    }
    if (!this.policy.workflowRefs.has(workflowRef)) {
      throw new Error('GitHub Actions OIDC workflow ref is not allowlisted');
    }
    if (!this.policy.workflowShas.has(workflowSha)) {
      throw new Error('GitHub Actions OIDC workflow SHA is not allowlisted');
    }
    return claims;
  }
}
