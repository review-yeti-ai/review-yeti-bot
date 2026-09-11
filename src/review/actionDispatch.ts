import { z } from 'zod';
import type { GitHubActionsOidcClaims } from '../auth/githubActionsOidc';
import { CENTRAL_REVIEW_REPOSITORY } from './reviewCheckIdentity';

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const positiveInteger = z.number().int().positive().safe();

export const actionDispatchRequestSchema = z.object({
  version: z.literal('ActionDispatch.v1'),
  deliveryId: z.string().min(1).max(512),
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  actionSha: sha,
  publishMode: z.enum(['disabled', 'app-gate']),
  /** Explicit same-head recovery requested by the trusted central workflow. */
  refreshRequested: z.boolean().optional(),
  /** One-based worker generation proven by the central check ledger. */
  refreshExecutionAttempt: positiveInteger.optional(),
  expectedGeneration: positiveInteger.optional(),
  checkId: positiveInteger.optional(),
  requestedAt: z.string().datetime({ offset: true }),
  caller: z.object({
    runId: z.string().regex(/^\d+$/u),
    runAttempt: positiveInteger,
    eventName: z.enum(['workflow_dispatch', 'pull_request_target', 'pull_request', 'repository_dispatch']),
    workflowRef: z.string().min(1).max(512).optional(),
    workflowSha: sha.optional(),
  }).strict(),
  policy: z.object({
    personas: z.string().optional(),
    maxInvestigationTurns: z.number().int().positive().optional(),
    laneCallBudget: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict().superRefine((request, context) => {
  if (request.refreshRequested === true && request.refreshExecutionAttempt === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'refresh execution attempt is required for an explicit retry',
      path: ['refreshExecutionAttempt'] });
  }
});

export type ActionDispatchRequest = z.infer<typeof actionDispatchRequestSchema>;

export function expectedActionDeliveryId(request: ActionDispatchRequest): string {
  return `actions:${request.caller.runId}:${request.caller.runAttempt}:${request.repositoryId}:${request.prNumber}:${request.headSha}`;
}

/** Excludes the freshness-only timestamp so a lost-response retry keeps the same delivery digest. */
export function actionDispatchDigestInput(request: ActionDispatchRequest): Omit<ActionDispatchRequest, 'requestedAt'> {
  const { requestedAt: _requestedAt, ...immutableRequest } = request;
  return immutableRequest;
}

export function assertActionDispatchMatchesClaims(request: ActionDispatchRequest, claims: GitHubActionsOidcClaims): void {
  const repository = `${request.owner}/${request.repo}`;
  const isDirect = repository === claims.repository && String(request.repositoryId) === claims.repository_id;
  const isCentral = request.caller.eventName === 'repository_dispatch'
    && claims.repository === CENTRAL_REVIEW_REPOSITORY
    && request.owner === 'calltelemetry';
  const matches = (isDirect || isCentral)
    && request.caller.runId === claims.run_id
    && String(request.caller.runAttempt) === claims.run_attempt
    && request.caller.eventName === claims.event_name
    && request.deliveryId === expectedActionDeliveryId(request);
  if (!matches) throw new Error('Action dispatch request identity does not match the verified GitHub OIDC claims');

  if (request.caller.workflowRef) {
    const refs = new Set([claims.workflow_ref, claims.job_workflow_ref].filter(Boolean));
    if (!refs.has(request.caller.workflowRef)) throw new Error('Action dispatch workflow ref does not match the verified GitHub OIDC claims');
  }
  if (request.caller.workflowSha) {
    const shas = new Set([claims.workflow_sha, claims.job_workflow_sha].filter(Boolean));
    if (!shas.has(request.caller.workflowSha)) throw new Error('Action dispatch workflow SHA does not match the verified GitHub OIDC claims');
  }
}
