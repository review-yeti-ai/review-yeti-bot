import {
  isAllowlistedWorkflowRef,
  type GitHubActionsOidcPolicy,
} from '../auth/githubActionsOidc';
import {
  CENTRAL_REVIEW_REPOSITORY,
  CENTRAL_REVIEW_WORKFLOW_REF,
  RECOVERABLE_FAILURE_TITLES,
  REVIEW_REFRESH_ACTION,
} from './reviewCheckIdentity';

export {
  CENTRAL_REVIEW_REPOSITORY,
  CENTRAL_REVIEW_WORKFLOW_REF,
  RECOVERABLE_FAILURE_TITLES,
  REVIEW_REFRESH_ACTION,
} from './reviewCheckIdentity';

/** The signed check action currently replaces only the first worker execution. */
export const REVIEW_REFRESH_EXECUTION_ATTEMPT = 1;

export interface CentralRefreshDispatchRequest {
  publishMode: 'disabled' | 'app-gate';
  refreshRequested?: boolean;
  caller: {
    eventName: string;
    workflowRef?: string;
  };
}

export interface CentralRefreshDispatchClaims {
  repository: string;
  job_workflow_ref?: string;
}

/**
 * Returns whether a dispatch carries an explicit refresh from the exact
 * central reusable workflow. Ordinary dispatches remain accepted without
 * retry fields; the caller applies this decision when building admission.
 */
export function isCentralRefreshAuthorized(
  request: CentralRefreshDispatchRequest,
  claims: CentralRefreshDispatchClaims,
  policy: Pick<GitHubActionsOidcPolicy, 'workflowRefs'> | undefined,
): boolean {
  return request.publishMode === 'app-gate'
    && request.caller.eventName === 'repository_dispatch'
    && request.refreshRequested === true
    && claims.repository === CENTRAL_REVIEW_REPOSITORY
    && claims.job_workflow_ref === CENTRAL_REVIEW_WORKFLOW_REF
    && request.caller.workflowRef === CENTRAL_REVIEW_WORKFLOW_REF
    && policy !== undefined
    && isAllowlistedWorkflowRef(policy, CENTRAL_REVIEW_WORKFLOW_REF);
}
