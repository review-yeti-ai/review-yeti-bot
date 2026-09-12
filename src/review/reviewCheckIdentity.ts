import { createHash } from 'node:crypto';
import { REVIEW_CI_CHECK_NAME } from './reviewCi';
import type { ReviewGateCoordinates } from './reviewGateContracts';

export { REVIEW_CI_CHECK_NAME } from './reviewCi';
export type { ReviewGateCoordinates } from './reviewGateContracts';
export const REVIEW_GATE_CHECK_NAME = 'Review Yeti Gate';

/** GitHub Check Run action used for a persisted same-head recovery request. */
export const REVIEW_REFRESH_ACTION = Object.freeze({
  label: 'Refresh review',
  description: 'Retry failed review for this exact head.',
  identifier: 'review-yeti/refresh',
});

/** Exact reusable workflow identity authorized to forward a persisted refresh. */
export const CENTRAL_REVIEW_REPOSITORY = 'calltelemetry/ct-review-actions';
export const CENTRAL_REVIEW_WORKFLOW_REF =
  `${CENTRAL_REVIEW_REPOSITORY}/.github/workflows/review-yeti.yml@refs/heads/v1`;

/** Failure titles for which the exact-head recovery action is offered/admitted. */
export const RECOVERABLE_FAILURE_TITLES: ReadonlySet<string> = new Set([
  'Review Yeti: review did not complete',
  'Review Yeti: NO VERDICT (no panel result for this head)',
]);

/** Minimal domain-owned shape used when checking a trusted workflow ref. */
export interface WorkflowRefAllowlist {
  workflowRefs: ReadonlySet<string>;
}

/** Applies the explicit workflow-ref allowlist without depending on auth. */
export function isAllowlistedWorkflowRef(
  policy: WorkflowRefAllowlist,
  workflowRef: string,
): boolean {
  return policy.workflowRefs.has('*') || policy.workflowRefs.has(workflowRef);
}

export type ReviewCheckName = typeof REVIEW_GATE_CHECK_NAME | typeof REVIEW_CI_CHECK_NAME;
export type ReviewGatePendingStatus = 'queued' | 'in_progress';
export type ReviewGateTerminalConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out';
export type ReviewGateObservedConclusion = ReviewGateTerminalConclusion
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale';

/** CI check identity is deliberately not represented as a ReviewGateCoordinates
 * cast. Its external ID is derived from the request UUID and immutable
 * validation identity digest. Delivery epochs and execution claims stay in the
 * durable CI request and are checked by the publisher separately. */
export interface ReviewCiCheckCoordinates {
  owner: string;
  repo: string;
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
  requestId: string;
  immutableBindingDigest: string;
  epoch: number;
}

export type ReviewCheckCoordinates = ReviewGateCoordinates | ReviewCiCheckCoordinates;

/** Structural GitHub-check observation used by domain and persistence ports. */
export interface ReviewGateCheck {
  id: number;
  name: ReviewCheckName;
  appId: number;
  headSha: string;
  externalId: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: ReviewGateObservedConclusion | null;
  htmlUrl?: string;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SAFE_ASCII = /^[\x21-\x7e]+$/u;
const EXACT_SHA = /^[a-f0-9]{40}$/u;
const EXACT_POLICY_DIGEST = /^[a-f0-9]{64}$/u;
const EXACT_RUN_ID = /^run_[a-f0-9]{32}$/u;
const EXACT_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

function requiredText(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER.test(value)) {
    throw new Error(`GitHub Review Yeti gate ${field} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub Review Yeti gate ${field} is invalid`);
  }
  return value;
}

function validateCommonCoordinates(input: unknown): Omit<ReviewGateCoordinates, 'runId' | 'attemptId' | 'executionAttempt'> {
  if (!input || typeof input !== 'object') throw new Error('GitHub Review Yeti gate coordinates are invalid');
  const candidate = input as Record<string, unknown>;
  const owner = requiredText(candidate.owner, 'owner', 100);
  const repo = requiredText(candidate.repo, 'repo', 100);
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
    throw new Error('GitHub Review Yeti gate repository identity is invalid');
  }
  const headSha = requiredText(candidate.headSha, 'head SHA', 256);
  const baseSha = requiredText(candidate.baseSha, 'base SHA', 256);
  const policyDigest = requiredText(candidate.policyDigest, 'policy digest', 512);
  if (!EXACT_SHA.test(headSha) || !EXACT_SHA.test(baseSha)) {
    throw new Error('GitHub Review Yeti gate commit identity is invalid');
  }
  if (!EXACT_POLICY_DIGEST.test(policyDigest)) {
    throw new Error('GitHub Review Yeti gate policy digest is invalid');
  }
  return {
    owner,
    repo,
    repositoryId: positiveInteger(candidate.repositoryId, 'repository id'),
    prNumber: positiveInteger(candidate.prNumber, 'pull request number'),
    headSha,
    baseSha,
    policyDigest,
  };
}

export function validateReviewCheckCoordinates(input: unknown, checkName: ReviewCheckName): ReviewCheckCoordinates {
  const common = validateCommonCoordinates(input);
  const candidate = input as Record<string, unknown>;
  if (checkName === REVIEW_GATE_CHECK_NAME) {
    const runId = requiredText(candidate.runId, 'run id', 512);
    const attemptId = requiredText(candidate.attemptId, 'attempt id', 512);
    if (!EXACT_RUN_ID.test(runId)) throw new Error('GitHub Review Yeti gate run id is invalid');
    if (!SAFE_ASCII.test(attemptId)) {
      throw new Error('GitHub Review Yeti gate attempt id is invalid');
    }
    return { ...common, runId, attemptId, executionAttempt: positiveInteger(candidate.executionAttempt, 'execution attempt') };
  }
  if (checkName !== REVIEW_CI_CHECK_NAME) throw new Error('Untrusted service check identity');
  const requestId = requiredText(candidate.requestId, 'request id', 64);
  const immutableBindingDigest = requiredText(candidate.immutableBindingDigest, 'binding digest', 64);
  if (!EXACT_REQUEST_ID.test(requestId) || !EXACT_POLICY_DIGEST.test(immutableBindingDigest)) {
    throw new Error('GitHub Review Yeti CI check identity is invalid');
  }
  return { ...common, requestId, immutableBindingDigest,
    epoch: positiveInteger(candidate.epoch, 'CI delivery epoch') };
}

export function deriveReviewCheckExternalId(coordinates: ReviewCheckCoordinates, checkName: ReviewCheckName): string {
  if (checkName === REVIEW_GATE_CHECK_NAME) {
    const normalized = validateReviewCheckCoordinates(coordinates, checkName) as ReviewGateCoordinates;
    const canonical = JSON.stringify([
      normalized.owner,
      normalized.repo,
      normalized.repositoryId,
      normalized.prNumber,
      normalized.headSha,
      normalized.baseSha,
      normalized.policyDigest,
      normalized.runId,
      normalized.attemptId,
      normalized.executionAttempt,
    ]);
    return `review-yeti-gate:v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  }
  const normalized = validateReviewCheckCoordinates(coordinates, checkName) as ReviewCiCheckCoordinates;
  const canonical = JSON.stringify([
    'ReviewCiCheckExternalId.v1',
    normalized.requestId,
    normalized.immutableBindingDigest,
  ]);
  return `review-yeti-ci:v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Derives the immutable GitHub Gate external ID. */
export function deriveReviewGateExternalId(coordinates: ReviewGateCoordinates): string {
  return deriveReviewCheckExternalId(coordinates, REVIEW_GATE_CHECK_NAME);
}

/** Derives the typed service-owned CI check external ID. */
export function deriveReviewCiCheckExternalId(coordinates: ReviewCiCheckCoordinates): string {
  return deriveReviewCheckExternalId(coordinates, REVIEW_CI_CHECK_NAME);
}
