import { describe, expect, it } from 'vitest';
import {
  CENTRAL_REVIEW_REPOSITORY,
  CENTRAL_REVIEW_WORKFLOW_REF,
  isCentralRefreshAuthorized,
  type CentralRefreshDispatchClaims,
  type CentralRefreshDispatchRequest,
} from '../../src/review/reviewRecoveryPolicy';

const policy = { workflowRefs: new Set([CENTRAL_REVIEW_WORKFLOW_REF]) };

function request(overrides: Partial<CentralRefreshDispatchRequest> = {}): CentralRefreshDispatchRequest {
  return {
    publishMode: 'app-gate',
    refreshRequested: true,
    caller: { eventName: 'repository_dispatch', workflowRef: CENTRAL_REVIEW_WORKFLOW_REF },
    ...overrides,
  };
}

function claims(overrides: Partial<CentralRefreshDispatchClaims> = {}): CentralRefreshDispatchClaims {
  return {
    repository: CENTRAL_REVIEW_REPOSITORY,
    job_workflow_ref: CENTRAL_REVIEW_WORKFLOW_REF,
    ...overrides,
  };
}

describe('central Review Yeti refresh policy', () => {
  it('authorizes only the exact central workflow identity with an explicit refresh', () => {
    expect(isCentralRefreshAuthorized(request(), claims(), policy)).toBe(true);
  });

  it.each([
    ['disabled publication', request({ publishMode: 'disabled' }), claims(), policy],
    ['missing refresh request', request({ refreshRequested: false }), claims(), policy],
    ['non-central event', request({ caller: { eventName: 'workflow_dispatch', workflowRef: CENTRAL_REVIEW_WORKFLOW_REF } }), claims(), policy],
    ['wrong repository', request(), claims({ repository: 'calltelemetry/other' }), policy],
    ['wrong verified workflow', request(), claims({ job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/other.yml@refs/heads/v1' }), policy],
    ['wrong caller workflow', request({ caller: { eventName: 'repository_dispatch', workflowRef: 'calltelemetry/ct-review-actions/.github/workflows/other.yml@refs/heads/v1' } }), claims(), policy],
    ['missing verifier policy', request(), claims(), undefined],
    ['unallowlisted workflow', request(), claims(), { workflowRefs: new Set<string>() }],
  ])('rejects %s', (_reason, candidate, candidateClaims, candidatePolicy) => {
    expect(isCentralRefreshAuthorized(candidate, candidateClaims, candidatePolicy)).toBe(false);
  });
});
