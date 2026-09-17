import { z } from 'zod';
import { sha256 } from './reviewCore';
import type { WorkerReviewEvidence } from './workerReviewCompletion';
// `workerFailureClasses`/`WorkerFailureClass` live in the neutral `../types/workerFailure` module
// (REL-892 finding 3) so the panel domain (`../panel/types`, `../panel/panelEngine`) can use them
// without importing this boundary module. Re-exported here so existing callers that import them
// from this path (e.g. `../review/workerReviewCompletion`) keep working unchanged.
import { workerFailureClasses, type WorkerFailureClass } from '../types/workerFailure';
// `redactWorkerFailureLogTail`/`MAX_WORKER_FAILURE_LOG_TAIL_BYTES` live in the neutral
// `../utils/workerFailureLogRedaction` module (REL-892 finding 1) so the gateway domain
// (`../gateway/omniRouteClient`, `../gateway/openRouterClient`) can use the redactor for its own
// raw network-failure log lines without importing this boundary module. Re-exported here so
// existing callers that import them from this path keep working unchanged; used locally below
// because a bare `export { x } from './y'` does not bring `x` into this module's own scope.
import { redactWorkerFailureLogTail, MAX_WORKER_FAILURE_LOG_TAIL_BYTES } from '../utils/workerFailureLogRedaction';

export { workerFailureClasses };
export type { WorkerFailureClass };
export { redactWorkerFailureLogTail, MAX_WORKER_FAILURE_LOG_TAIL_BYTES };

const runId = z.string().regex(/^run_[a-f0-9]{32}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();

/**
 * REL-896: the Go operator's PRReviewJob controller observes a publishing
 * worker Job fail, disappear, or outlive its deadline and records exactly one
 * of these on the `Ready` condition's `Reason` before delegating publication
 * to the dispatcher's abandoned-run reaper (see
 * `k8s-operator/controllers/prreviewjob_v1alpha2_controller.go`:
 * `startFailurePublication`, called with `"WorkerFailed"`, `"DeadlineExpired"`,
 * or `"WorkerJobMissing"`). These are the durable, bounded diagnostic
 * `reason` values the TypeScript side normalizes those operator reasons into
 * -- see `src/k8s/delegatedFailureReader.ts`. `worker_deadline_exceeded`
 * intentionally reuses the same word `workerFailureReason('timeout')` already
 * emits below: both describe the same condition observed by a different
 * component.
 */
export const delegatedFailureReasons = [
  'worker_failed',
  'worker_deadline_exceeded',
  'worker_job_missing',
] as const;

export type DelegatedFailureReason = typeof delegatedFailureReasons[number];

export const workerFailureDiagnosticsSchema = z.object({
  /** Stable, non-secret category for operators and recovery automation. */
  reason: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/u),
  /** Provider HTTP status when one was observed; omitted for local failures. */
  providerStatus: z.number().int().min(100).max(599).optional(),
  /** Last bounded, redacted worker log line(s). */
  logTail: z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_WORKER_FAILURE_LOG_TAIL_BYTES,
    `logTail must be at most ${MAX_WORKER_FAILURE_LOG_TAIL_BYTES} UTF-8 bytes`,
  ),
  /**
   * Set by the publishing worker exactly when `isRecoverableIncompletePanel`
   * classified this failure (REL-620): an optional lane died and nothing else
   * found anything, so the incompleteness -- not the code -- is what failed.
   * The dispatcher trusts this bearer-authenticated bounded boolean the same
   * way it already trusts `failureClass`; it never re-derives the panel
   * evidence itself. Omitted or false means the failure is not eligible for
   * the bounded automatic retry, regardless of `failureClass`.
   */
  recoverableIncompletePanel: z.boolean().optional(),
}).strict();

export type WorkerFailureDiagnostics = z.infer<typeof workerFailureDiagnosticsSchema>;

export interface DurableWorkerFailureDiagnostics extends WorkerFailureDiagnostics {
  failureClass: WorkerFailureClass;
  executionAttempt?: number;
}

export const workerTerminalFailureSchema = z.object({
  version: z.literal('WorkerTerminalFailure.v1'),
  runId,
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  checkId: positiveInteger.optional(),
  failureClass: z.enum(workerFailureClasses),
  /** Optional for mixed-version workers; new workers always send it. */
  diagnostics: workerFailureDiagnosticsSchema.optional(),
}).strict();

export type WorkerTerminalFailure = z.infer<typeof workerTerminalFailureSchema>;

/** A legacy publishing worker may report success only after its exact GitHub
 * check has been completed successfully. Unlike the authoritative completion
 * contract, this records lifecycle state; it does not re-arbitrate the verdict. */
export const workerTerminalSuccessSchema = z.object({
  version: z.literal('WorkerTerminalSuccess.v1'),
  runId,
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  checkId: positiveInteger,
  /** Optional WorkerReviewResult.v1: the persona lanes and findings behind the
   * check the worker published. Evidence only; it never re-arbitrates the
   * verdict or selects a check. Validated by the service with the same bounds
   * as the authoritative completion contract before it is persisted. */
  result: z.unknown().optional(),
}).strict();

export type WorkerTerminalSuccess = z.infer<typeof workerTerminalSuccessSchema>;

/** Lifecycle identity of a terminal success. The optional result is evidence,
 * not identity: a retry that omits or repeats it must not read as a conflict. */
export function workerTerminalSuccessDigest(input: unknown): string {
  const { result: _result, ...identity } = workerTerminalSuccessSchema.parse(input);
  return sha256(identity);
}

/** The dispatch service derives this only from the bearer; it is never sent by the worker. */
export interface WorkerCompletionProof {
  workerTokenDigest: string;
}

export interface WorkerCompletionAdapter {
  reportTerminalFailure(event: WorkerTerminalFailure): Promise<void>;
  reportTerminalSuccess(event: WorkerTerminalSuccess): Promise<void>;
  /** Findings behind a self-published check, for either conclusion. Optional
   * so an adapter that predates the contract still satisfies the interface. */
  reportReviewEvidence?(event: WorkerReviewEvidence): Promise<void>;
}

/**
 * The one exported explanation of what a GitHub HTTP 406 qualification-read
 * failure means for an operator. Both the bounded diagnostic log tail
 * (`buildWorkerFailureDiagnostics`) and the published check summary
 * (`renderFailureSummary` in `../cli/publishingReview`) render this same text
 * instead of each keeping their own copy of the "too large" explanation. Kept
 * free of the redaction filter's disclosure-boundary words (request/response/
 * body/content/...) so it survives `redactWorkerFailureLogTail` intact.
 */
export const GITHUB_DIFF_NOT_RENDERABLE_EXPLANATION =
  'GitHub returned HTTP 406: this diff is too large to render as configured (roughly over 20,000 changed lines '
  + 'or 300 files). This is a permanent property of this head, not an infrastructure outage.';

/**
 * Message/status-pattern fallback shared by both classification call sites: the panel's
 * `classifyPersonaAttemptFailure` (`../panel/panelEngine`), which classifies a single persona
 * attempt's terminal error at the exact point `runPersona` observed it, and the publisher's
 * `classifyFailure` (`../cli/publishingReview`), which only ever sees a lane's already-joined,
 * cross-attempt free-form message. Both used to re-implement this same regex ladder
 * independently (REL-892 finding: two implementations of one decision that can drift); it now
 * lives in exactly one place.
 *
 * Deliberately excludes the concrete OpenRouter/Upstream-capacity/panel-structured-output
 * `instanceof` checks each call site performs before falling back here. Those checks are typed
 * and unambiguous -- unlike a regex, they cannot silently drift out of sync with the classes they
 * test -- and each call site already imports the relevant transport or panel-internal error class
 * for its own retry/failover decisions, so keeping them local costs nothing and keeps this module
 * free of a dependency on gateway transport types (the same boundary `buildWorkerFailureDiagnostics`
 * above already keeps with GitHub transport types).
 */
export function classifyWorkerFailureMessage(error: unknown): WorkerFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/turn budget exhausted|budget exhausted|exceeded total retry\/execution budget/iu.test(message)) return 'budget_exhausted';
  if (/timeout|timed out|ETIMEDOUT|exceeded (?:the )?(?:total )?deadline/iu.test(message)) return 'timeout';
  if (/401|403|unauthor|virtual key/iu.test(message)) return 'auth';
  if (/429|rate limit/iu.test(message)) return 'rate_limit';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/iu.test(message)) return 'transport';
  if (/invalid (?:or missing )?(?:native )?JSON|native JSON response must be an object|invalid findings contract|invalid .*response contract|cannot contain findings|requires at least one finding|nonce-fenced structured output|reported INCOMPLETE without a completed review|optional reviewer did not complete/iu.test(message)) {
    return 'malformed_output';
  }
  if (/provider|gateway|model/iu.test(message)) return 'provider_error';
  return 'internal_error';
}

export function workerFailureReason(failureClass: WorkerTerminalFailure['failureClass']): string {
  return {
    contract: 'worker_contract_invalid',
    timeout: 'worker_deadline_exceeded',
    budget_exhausted: 'worker_budget_exhausted',
    auth: 'provider_authentication_failed',
    rate_limit: 'provider_rate_limited',
    transport: 'provider_transport_failed',
    provider_error: 'provider_request_failed',
    malformed_output: 'provider_structured_output_invalid',
    internal_error: 'worker_internal_error',
  }[failureClass];
}

/** Normalize worker context at the persistence boundary, retaining only
 * bounded fields that operators and recovery automation can safely consume. */
export function buildDurableWorkerFailureDiagnostics(
  failureClass: WorkerFailureClass,
  diagnostics?: Partial<WorkerFailureDiagnostics>,
  executionAttempt?: number,
): DurableWorkerFailureDiagnostics {
  const providerStatus = diagnostics?.providerStatus;
  const safeProviderStatus = typeof providerStatus === 'number' && Number.isInteger(providerStatus)
    && providerStatus >= 100 && providerStatus <= 599 ? providerStatus : undefined;
  const reason = typeof diagnostics?.reason === 'string'
    && /^[a-z][a-z0-9_.:-]{0,127}$/u.test(diagnostics.reason)
    ? diagnostics.reason : workerFailureReason(failureClass);
  const logTail = redactWorkerFailureLogTail(diagnostics?.logTail) || workerFailureReason(failureClass);
  return {
    failureClass,
    reason,
    ...(safeProviderStatus === undefined ? {} : { providerStatus: safeProviderStatus }),
    logTail,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
    // Re-derive from the worker's own boolean rather than trusting an
    // arbitrary passthrough: this is the one bit the dispatcher's automatic
    // retry decision reads, so it is normalized to a strict boolean here the
    // same way every other durable field on this object is.
    ...(diagnostics?.recoverableIncompletePanel === true ? { recoverableIncompletePanel: true } : {}),
  };
}

/**
 * Build the redacted diagnostic emitted by the publishing worker.
 * `options.recoverableIncompletePanel` must be set only when the caller
 * already classified this exact failure with `isRecoverableIncompletePanel`
 * -- it is never inferred from `failureClass` or the error text here, so a
 * future failure class cannot silently become auto-retryable by accident.
 *
 * This module has no dependency on GitHub transport types: a caller that
 * already holds the original error (and can check it against
 * `GitHubQualificationReadError` from `../github/qualificationReader`) decides
 * whether the failure is the GitHub-diff-too-large case and passes that
 * decision in via `options.githubDiffNotRenderable`, rather than this
 * function parsing the error's message or importing from `../github/`.
 */
export function buildWorkerFailureDiagnostics(
  error: unknown,
  failureClass: WorkerTerminalFailure['failureClass'],
  options?: { githubDiffNotRenderable?: boolean; recoverableIncompletePanel?: boolean },
): WorkerFailureDiagnostics {
  const providerStatus = error && typeof error === 'object' && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  const safeStatus = Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599
    ? providerStatus : undefined;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (options?.githubDiffNotRenderable) {
    return {
      reason: 'github_diff_not_renderable',
      providerStatus: 406,
      logTail: redactWorkerFailureLogTail(`${GITHUB_DIFF_NOT_RENDERABLE_EXPLANATION} ${message}`),
    };
  }
  return {
    reason: workerFailureReason(failureClass),
    ...(safeStatus === undefined ? {} : { providerStatus: safeStatus }),
    logTail: redactWorkerFailureLogTail(message || workerFailureReason(failureClass)),
    ...(options?.recoverableIncompletePanel === true ? { recoverableIncompletePanel: true } : {}),
  };
}

export function validateWorkerCompletionEndpoint(endpoint: string): string {
  const normalizedEndpoint = endpoint.trim();
  if (!normalizedEndpoint) throw new Error('worker completion endpoint is required');
  let parsed: URL;
  try {
    parsed = new URL(normalizedEndpoint);
  } catch {
    throw new Error('worker completion endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.host || parsed.username || parsed.password || parsed.hash) {
    throw new Error('worker completion endpoint must be an HTTPS URL without userinfo or fragments');
  }
  return normalizedEndpoint;
}

/**
 * Sends only the typed terminal-failure event. The provider error itself never
 * crosses the worker boundary: upstream responses can contain prompts, keys, or
 * other sensitive material. New workers add a bounded redacted diagnostic tail
 * and status/category fields; older workers remain valid during rollout.
 */
export class HttpWorkerCompletionAdapter implements WorkerCompletionAdapter {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: {
    token: string;
    endpoint: string;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!options.token.startsWith('ghs_')) throw new Error('worker completion requires a ghs_ installation token');
    const endpoint = validateWorkerCompletionEndpoint(options.endpoint);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error('worker completion timeout must be between 250ms and 30000ms');
    }
    this.endpoint = endpoint;
    this.token = options.token;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
  }

  async reportTerminalFailure(event: WorkerTerminalFailure): Promise<void> {
    await this.report(event);
  }

  async reportTerminalSuccess(event: WorkerTerminalSuccess): Promise<void> {
    await this.report(event);
  }

  async reportReviewEvidence(event: WorkerReviewEvidence): Promise<void> {
    await this.report(event);
  }

  private async report(event: WorkerTerminalFailure | WorkerTerminalSuccess | WorkerReviewEvidence): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`worker completion callback failed with HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
