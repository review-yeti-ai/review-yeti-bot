import { deriveRunSecretExecutionAttempt } from './reviewJobProjection';
import { kubernetesStatusCode } from './kubernetesReviewJobProjector';
import { delegatedFailureReasons, type DelegatedFailureReason } from '../review/workerCompletion';
import { logger } from '../utils/logger';

const GROUP = 'review-yeti.ai';
const VERSION = 'v1alpha2';
const PLURAL = 'prreviewjobs';

/**
 * Set by `reconcileFailurePublication`
 * (`k8s-operator/controllers/prreviewjob_v1alpha2_controller.go:537-544`) once
 * the operator has stopped the worker Job and delegated exact-identity
 * publication to this trusted service. Its `Reason` is always this constant;
 * the specific operator classification (`WorkerFailed` / `DeadlineExpired` /
 * `WorkerJobMissing`) lives on the `Ready` condition instead, set once by
 * `startFailurePublication` (same file, lines 463-470) and never mutated
 * again.
 */
const FAILURE_PUBLICATION_CONDITION_TYPE = 'FailurePublication';
const FAILURE_PUBLICATION_DELEGATED_REASON = 'DelegatedToTrustedService';
const READY_CONDITION_TYPE = 'Ready';

/** Default: `terminal_deadline` is only checked every dispatcher loop tick;
 * this reader may lag it without harm. Bounded below so a misconfigured env
 * cannot turn this into a tight poll against the API server. */
export const DEFAULT_DELEGATED_FAILURE_POLL_MS = 15_000;
export const MIN_DELEGATED_FAILURE_POLL_MS = 5_000;

/** Bounds the candidates handed to the reaper's claim query each cycle,
 * independent of the caller's overall reaper `limit`. */
export const DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES = 50;

/** Maps the Go operator's `Ready` condition `Reason` (see
 * `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go` lines 138,
 * 345, 350, 437) to the bounded diagnostic reason this service persists.
 * `WorkerContractMismatch` (line 996) and any other future reason are
 * deliberately left unmapped: an unrecognized reason is not surfaced as a
 * candidate, so an unknown operator classification degrades to the existing
 * deadline-based reaper path rather than being guessed at.
 */
const READY_REASON_TO_DELEGATED_FAILURE_REASON: Readonly<Record<string, DelegatedFailureReason>> = {
  WorkerFailed: 'worker_failed',
  DeadlineExpired: 'worker_deadline_exceeded',
  WorkerJobMissing: 'worker_job_missing',
};

export interface DelegatedFailureCandidate {
  runId: string;
  executionAttempt: number;
  reason: DelegatedFailureReason;
  message: string;
  observedAt: number;
}

export interface DelegatedFailureListClient {
  listNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<unknown>;
}

export interface DelegatedFailureReaderOptions {
  client: DelegatedFailureListClient;
  namespace: string;
  /** Milliseconds between `list` calls; clamped to at least
   * `MIN_DELEGATED_FAILURE_POLL_MS`, defaulting to
   * `DEFAULT_DELEGATED_FAILURE_POLL_MS` when omitted or invalid. */
  pollIntervalMs?: number;
  /** Caps candidates returned per poll. Defaults to
   * `DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES`. */
  maxCandidates?: number;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function conditionsArray(status: unknown): Record<string, unknown>[] {
  const conditions = record(status)?.conditions;
  if (!Array.isArray(conditions)) return [];
  return conditions.filter((entry): entry is Record<string, unknown> => record(entry) !== undefined);
}

function findCondition(conditions: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return conditions.find((condition) => condition.type === type);
}

function isoToMillis(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveDelegatedFailurePollMs(requested?: number): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < MIN_DELEGATED_FAILURE_POLL_MS) {
    return DEFAULT_DELEGATED_FAILURE_POLL_MS;
  }
  return requested;
}

function resolveExecutionAttempt(spec: Record<string, unknown>): number | undefined {
  if (Number.isSafeInteger(spec.executionAttempt) && Number(spec.executionAttempt) > 0) {
    return Number(spec.executionAttempt);
  }
  // Older admissions may omit spec.executionAttempt; recover it the same way
  // the projector's legacy comparison path does (reviewJobProjection.ts).
  return deriveRunSecretExecutionAttempt(spec.runId, spec.runSecretName);
}

function extractCandidate(item: unknown): DelegatedFailureCandidate | undefined {
  const resource = record(item);
  const spec = record(resource?.spec);
  const status = record(resource?.status);
  if (!resource || !spec || !status) return undefined;

  const conditions = conditionsArray(status);
  const failurePublication = findCondition(conditions, FAILURE_PUBLICATION_CONDITION_TYPE);
  if (!failurePublication
    || failurePublication.status !== 'Unknown'
    || failurePublication.reason !== FAILURE_PUBLICATION_DELEGATED_REASON) {
    return undefined;
  }

  const ready = findCondition(conditions, READY_CONDITION_TYPE);
  const rawReason = typeof ready?.reason === 'string' ? ready.reason : undefined;
  const reason = rawReason ? READY_REASON_TO_DELEGATED_FAILURE_REASON[rawReason] : undefined;
  if (!reason) return undefined;

  const runId = typeof spec.runId === 'string' ? spec.runId : undefined;
  if (!runId || !/^run_[a-f0-9]{32}$/u.test(runId)) return undefined;

  const executionAttempt = resolveExecutionAttempt(spec);
  if (executionAttempt === undefined) return undefined;

  const observedAt = isoToMillis(failurePublication.lastTransitionTime) ?? isoToMillis(ready?.lastTransitionTime);
  if (observedAt === undefined) return undefined;

  const message = typeof failurePublication.message === 'string' && failurePublication.message
    ? failurePublication.message
    : (typeof ready?.message === 'string' ? ready.message : '');

  return { runId, executionAttempt, reason, message, observedAt };
}

function extractCandidates(response: unknown, maxCandidates: number): DelegatedFailureCandidate[] {
  const items = record(response)?.items;
  if (!Array.isArray(items)) return [];
  const candidates: DelegatedFailureCandidate[] = [];
  for (const item of items) {
    if (candidates.length >= maxCandidates) break;
    const candidate = extractCandidate(item);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Reads the Go operator's delegated-failure signal directly from the
 * `PRReviewJob` custom resource so the dispatcher's `AbandonedRunReaper` can
 * act on it before `terminal_deadline` instead of only after (REL-896).
 *
 * FAIL SOFT: `list` on `prreviewjobs` is a new RBAC grant the deployed Role
 * may not carry yet. Any list failure (403 while the grant is missing,
 * transient API error, etc.) is caught, logged once per poll interval, and
 * degrades to zero candidates -- the existing deadline-based reaper path is
 * completely unaffected by this reader failing.
 */
export class DelegatedFailureReader {
  private readonly client: DelegatedFailureListClient;
  private readonly namespace: string;
  private readonly pollIntervalMs: number;
  private readonly maxCandidates: number;
  private readonly now: () => number;
  private lastListedAt = -Infinity;
  private lastWarnAt = -Infinity;
  private cached: DelegatedFailureCandidate[] = [];

  constructor(options: DelegatedFailureReaderOptions) {
    if (!options.namespace.trim()) throw new Error('delegated failure reader namespace is required');
    this.client = options.client;
    this.namespace = options.namespace;
    this.pollIntervalMs = resolveDelegatedFailurePollMs(options.pollIntervalMs);
    this.maxCandidates = Number.isSafeInteger(options.maxCandidates) && Number(options.maxCandidates) > 0
      ? Number(options.maxCandidates) : DEFAULT_MAX_DELEGATED_FAILURE_CANDIDATES;
    this.now = options.now || Date.now;
  }

  async listCandidates(): Promise<DelegatedFailureCandidate[]> {
    const now = this.now();
    if (now - this.lastListedAt < this.pollIntervalMs) return this.cached;
    this.lastListedAt = now;
    try {
      const response = await this.client.listNamespacedCustomObject({
        group: GROUP, version: VERSION, namespace: this.namespace, plural: PLURAL,
      });
      this.cached = extractCandidates(response, this.maxCandidates);
    } catch (error) {
      this.cached = [];
      this.warnRateLimited(error, now);
    }
    return this.cached;
  }

  private warnRateLimited(error: unknown, now: number): void {
    if (now - this.lastWarnAt < this.pollIntervalMs) return;
    this.lastWarnAt = now;
    const status = kubernetesStatusCode(error);
    logger.warn('Failed to list delegated PRReviewJob failure signals; deadline-based reaping is unaffected', {
      ...(status === undefined ? {} : { status }),
    });
  }
}

export { delegatedFailureReasons, type DelegatedFailureReason };
