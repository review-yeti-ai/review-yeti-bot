import { z } from 'zod';
import { sha256 } from './reviewCore';

/** Domain/wire contracts only. None of these values authenticates a caller. */
export const REVIEW_CI_EVENT = 'review-yeti-ci-request';
export const REVIEW_CI_CHECK_NAME = 'Review Yeti CI';
const integer = z.number().int().positive().safe();
const counter = z.number().int().min(0).max(2_147_483_647);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const requestId = z.string().uuid().regex(/^[a-f0-9-]+$/u);
const attemptId = z.string().max(120).regex(/^run_[a-f0-9]{32}-g(?:0|[1-9]\d*)-e[1-9]\d*$/u);

export const reviewCiCoordinatesSchema = z.object({
  repositoryId: integer, owner: name, repo: name, prNumber: integer,
  baseSha: sha, headSha: sha, policyDigest: digest,
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  attemptId, reviewGeneration: counter, executionAttempt: counter.refine((n) => n > 0),
}).strict().refine((value) => value.attemptId
  === `${value.runId}-g${value.reviewGeneration}-e${value.executionAttempt}`);
export type ReviewCiCoordinates = z.infer<typeof reviewCiCoordinatesSchema>;

export const reviewCiRequestEventSchema = z.object({
  schema_version: z.literal('review-yeti-ci-request.v1'),
  repository_id: integer, repository: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
    .refine((value) => value.split('/').every((part) => part !== '.' && part !== '..')),
  pr_number: integer, base_sha: sha, head_sha: sha, attempt_id: attemptId,
  policy_digest: digest, validation_request_id: requestId,
}).strict();
export type ReviewCiRequestEvent = z.infer<typeof reviewCiRequestEventSchema>;

const jobName = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/u).refine((v) => v.trim() === v);
const unique = (values: string[]) => new Set(values).size === values.length;
const lanePlanFields = z.object({
  version: z.literal('ReviewCiLanePlan.v1'),
  lanes: z.array(z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/u)).min(1).max(64).refine(unique),
  requiredJobs: z.array(jobName).min(1).max(100).refine(unique),
}).strict();
export const reviewCiLanePlanSchema = lanePlanFields.extend({ digest }).strict().refine((plan) =>
  plan.digest === sha256({ version: plan.version, lanes: [...plan.lanes].sort(), requiredJobs: [...plan.requiredJobs].sort() }));
export type ReviewCiLanePlan = z.infer<typeof reviewCiLanePlanSchema>;
export interface ReviewCiWorkflowConfig {
  workflowId: number;
  workflowPath: string;
  workflowRef: string;
  workflowSha: string;
}
export interface ReviewCiRepositoryConfig {
  repositoryId: number;
  ownerId: number;
  owner: string;
  repo: string;
  relay: ReviewCiWorkflowConfig;
  validation: ReviewCiWorkflowConfig;
  lanePlan: ReviewCiLanePlan;
}
export interface ReviewCiServiceConfig {
  expectedAppId: number;
  admissionEnabled: boolean;
  repositoryDispatchEnabled: boolean;
  repositories: ReviewCiRepositoryConfig[];
  tickMs: number;
}
export interface ReviewCiEnrollmentIdentity {
  expectedAppId: number;
  repository: { repositoryId: number; owner: string; repo: string };
}
/** Resolve one exact service-owned enrollment without depending on auth or
 * environment parsing. Boundary callers retain their own error taxonomy. */
export function findReviewCiEnrollment(config: ReviewCiServiceConfig,
  identity: ReviewCiEnrollmentIdentity): ReviewCiRepositoryConfig | undefined {
  const repository = config.repositories.find((candidate) =>
    candidate.repositoryId === identity.repository.repositoryId);
  return repository
    && repository.owner === identity.repository.owner
    && repository.repo === identity.repository.repo
    && config.expectedAppId === identity.expectedAppId
    ? repository
    : undefined;
}
export function createReviewCiLanePlan(lanes: string[], requiredJobs: string[]): ReviewCiLanePlan {
  const plan = lanePlanFields.parse({ version: 'ReviewCiLanePlan.v1', lanes, requiredJobs });
  plan.lanes.sort(); plan.requiredJobs.sort();
  return { ...plan, digest: sha256(plan) };
}

export const reviewCiValidationBindingSchema = z.object({
  candidateSha: sha,
  workflowId: integer,
  workflowPath: z.string().max(200).regex(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/u),
  /** Fully qualified configured ref, never a ref supplied by the PR. The HTTP client maps it to a named dispatch ref. */
  workflowRef: z.string().max(255).regex(/^refs\/(heads|tags)\/[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/u)
    .refine((v) => !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.')
      && v.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))),
  workflowSha: sha,
  lanePlan: reviewCiLanePlanSchema,
}).strict();
export type ReviewCiValidationBinding = z.infer<typeof reviewCiValidationBindingSchema>;

export interface ReviewCiValidationIdentity {
  requestId: string;
  review: ReviewCiCoordinates;
  expectedAppId: number;
  binding: ReviewCiValidationBinding;
}
export function reviewCiIdentityDigest(identity: ReviewCiValidationIdentity): string {
  // Exclude the opaque request ID from equivalence: another UUID must not buy
  // a second execution of the same complete validation identity.
  return sha256({ version: 'ReviewCiValidationIdentity.v1', review: reviewCiCoordinatesSchema.parse(identity.review),
    expectedAppId: integer.parse(identity.expectedAppId), binding: normalizeReviewCiBinding(identity.binding) });
}
export function normalizeReviewCiBinding(input: unknown): ReviewCiValidationBinding {
  const binding = reviewCiValidationBindingSchema.parse(input);
  binding.lanePlan.lanes.sort(); binding.lanePlan.requiredJobs.sort();
  return binding;
}
export function reviewCiRunName(id: string, epoch: number): string {
  return `review-yeti-ci:${requestId.parse(id)}:${integer.parse(epoch)}`;
}

/** Supplied only after OIDC + GitHub provenance checks by the trusted service. */
export const reviewCiExecutionSchema = z.object({
  requestId, epoch: integer, repositoryId: integer, workflowId: integer,
  workflowSha: sha, candidateSha: sha, runId: integer, runAttempt: integer,
  event: z.literal('workflow_dispatch'), runName: z.string().max(160),
}).strict().refine((v) => v.runName === reviewCiRunName(v.requestId, v.epoch));
export type ReviewCiExecution = z.infer<typeof reviewCiExecutionSchema>;

const conclusion = z.enum(['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure']);
export const reviewCiTerminalReceiptSchema = z.object({
  version: z.literal('ReviewCiTerminalReceipt.v1'),
  execution: reviewCiExecutionSchema,
  conclusion,
  jobs: z.array(z.object({
    id: integer, runId: integer, runAttempt: integer, name: jobName,
    status: z.literal('completed'), conclusion,
  }).strict()).min(1).max(200),
}).strict().refine((receipt) => new Set(receipt.jobs.map((job) => job.id)).size === receipt.jobs.length
  && receipt.jobs.every((job) => job.runId === receipt.execution.runId && job.runAttempt === receipt.execution.runAttempt));
export type ReviewCiTerminalReceipt = z.infer<typeof reviewCiTerminalReceiptSchema>;

export type ReviewCiState = 'pending' | 'admitted' | 'running' | 'completed' | 'superseded' | 'delivery_error';
export interface ReviewCiQueryable { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
export type ReviewCiTransition = 'recorded' | 'duplicate' | 'stale' | 'conflict';
export type ReviewCiStateTransition = 'admitted' | 'running' | 'completed' | 'superseded' | 'delivery_error';
export interface StoredReviewCiRequest {
  requestId: string;
  review: ReviewCiCoordinates;
  expectedAppId: number;
  state: ReviewCiState;
  binding: ReviewCiValidationBinding | null;
  identityDigest: string | null;
  workflowEpoch: number;
  execution: ReviewCiExecution | null;
  terminalReceipt: ReviewCiTerminalReceipt | null;
}
export type ReviewCiDeliveryKind = 'repository' | 'workflow';
export interface ReviewCiCaller {
  role: 'relay' | 'validation';
  repository: { repositoryId: number; owner: string; repo: string; validation: { workflowId: number } };
  workflowSha: string;
  runId: number;
  runAttempt: number;
}
export type ReviewCiDispatchReceipt = { status: 'accepted'; runId?: number } | { status: 'uncertain' | 'rejected' };
export interface ReviewCiRunCorrelation { requestId: string; epoch: number }
export interface ReviewCiRunReadback extends ReviewCiRunCorrelation {
  runId: number;
  runAttempt: number;
  workflowSha: string;
  status: 'queued' | 'in_progress' | 'waiting' | 'requested' | 'pending' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'neutral' | 'skipped'
    | 'stale' | 'startup_failure' | null;
  requiredJobsPassed: boolean;
  requiredJobs: { id: number; name: string; status: string; conclusion: string | null }[];
}
/** Narrow GitHub capability consumed by the domain coordinator. Transport,
 * authentication, and response parsing remain adapter-owned. */
export interface ReviewCiClient {
  dispatchRepository(input: ReviewCiRequestEvent): Promise<ReviewCiDispatchReceipt>;
  dispatchWorkflow(input: ReviewCiRunCorrelation): Promise<ReviewCiDispatchReceipt>;
  correlateRun(input: ReviewCiRunCorrelation): Promise<{ runId: number; runAttempt: number } | null>;
  readRun(input: ReviewCiRunCorrelation & { runId: number; runAttempt: number }): Promise<ReviewCiRunReadback>;
  readTerminalReceipt(input: ReviewCiExecution): Promise<ReviewCiTerminalReceipt>;
}
export interface ReviewCiDeliveryClaim {
  request: StoredReviewCiRequest;
  kind: ReviewCiDeliveryKind;
  epoch: number;
  leaseOwner: string;
  leaseToken: string;
  /** Expired dispatch leases are reconcile-only, never permission to POST again. */
  mode: 'dispatch' | 'reconcile';
}
/** Trusted service attestation of a bounded negative readback, not a wire input.
 * It is persisted before an old epoch is fenced. Absence alone is NOT proof of non-acceptance. */
export const reviewCiAbsentReconciliationSchema = z.object({
  outcome: z.literal('absent'), requestId, kind: z.enum(['repository', 'workflow']), epoch: counter,
  observedAt: z.number().int().min(0).safe(),
}).strict().refine((v) => v.kind === 'repository' ? v.epoch === 0 : v.epoch > 0);
export type ReviewCiAbsentReconciliation = z.infer<typeof reviewCiAbsentReconciliationSchema>;

/** Structural service port. Persistence implementations may use PostgreSQL,
 * but the coordinator depends only on this domain contract. */
export interface ReviewCiRepository {
  get(requestId: string): Promise<StoredReviewCiRequest | null>;
  listPending(limit?: number, afterRequestId?: string): Promise<StoredReviewCiRequest[]>;
  admit(requestId: string, input: unknown,
    validateCurrent: (request: StoredReviewCiRequest, binding: ReviewCiValidationBinding) => Promise<void>,
    now?: number): Promise<ReviewCiTransition | 'busy'>;
  supersede(requestId: string, now?: number): Promise<ReviewCiTransition>;
  claimDelivery(kind: ReviewCiDeliveryKind, workerId: string, now?: number, leaseMs?: number): Promise<ReviewCiDeliveryClaim | null>;
  markDeliveryUncertain(claim: ReviewCiDeliveryClaim, errorClass: 'transport' | 'timeout', now?: number,
    delayMs?: number): Promise<ReviewCiTransition>;
  rejectDelivery(claim: ReviewCiDeliveryClaim, now?: number): Promise<ReviewCiTransition>;
  acknowledgeRepositoryDispatch(claim: ReviewCiDeliveryClaim, now?: number): Promise<ReviewCiTransition>;
  acknowledgeWorkflowDispatch(claim: ReviewCiDeliveryClaim, input: unknown, now?: number,
    delayMs?: number): Promise<ReviewCiTransition>;
  retryUncertainDelivery(claim: ReviewCiDeliveryClaim, reconciliation: ReviewCiAbsentReconciliation,
    now?: number, delayMs?: number): Promise<ReviewCiTransition | 'exhausted'>;
  claimExecution(input: unknown, validateCurrent: (request: StoredReviewCiRequest) => Promise<void>,
    now?: number): Promise<ReviewCiTransition>;
  recordTerminalReceipt(input: unknown, validateCurrent: (request: StoredReviewCiRequest) => Promise<void>,
    now?: number): Promise<ReviewCiTransition>;
}
export function reviewCiRequestEvent(request: StoredReviewCiRequest): ReviewCiRequestEvent {
  const review = reviewCiCoordinatesSchema.parse(request.review);
  return reviewCiRequestEventSchema.parse({ schema_version: 'review-yeti-ci-request.v1',
    repository_id: review.repositoryId, repository: `${review.owner}/${review.repo}`,
    pr_number: review.prNumber, base_sha: review.baseSha, head_sha: review.headSha,
    attempt_id: review.attemptId, policy_digest: review.policyDigest, validation_request_id: request.requestId });
}
