import type { OpenRouterRequest, OpenRouterResponse, ReviewModelClient } from '../gateway/openRouterClient';
import { resolveCachedTokens } from '../gateway/openRouterClient';
import { logger } from '../utils/logger';

export type PublishingProgressRole = 'persona' | 'moderator' | 'arbiter' | 'classifier' | 'map_reduce_reduce' | 'composed_plan' | 'composed_task' | 'other';
export type PublishingProgressStatus = 'started' | 'completed' | 'failed' | 'aborted' | 'skipped' | 'blocked' | 'rejected';
export type PublishingProgressRejectionCode =
  | 'aborted' | 'timeout' | 'rate_limit' | 'transport' | 'provider_error' | 'malformed_output'
  | 'configuration' | 'budget_exhausted' | 'internal_error' | 'contract' | 'auth' | 'unknown' | 'invalid_task_output'
  | 'findings_contract_invalid' | 'finding_path_invalid' | 'finding_path_not_changed'
  | 'finding_line_invalid' | 'finding_line_not_added' | 'finding_line_unanchorable' | 'finding_severity_invalid';

export interface PublishingProgressIdentity {
  runId: string;
  executionAttempt: number;
}

export interface PublishingProgressEvent {
  task: 'panel' | 'persona_lane' | 'composed_plan' | 'composed_task' | 'provider_call' | 'provider_output';
  status: PublishingProgressStatus;
  role?: PublishingProgressRole;
  lane?: string;
  provider?: string;
  model?: string;
  turn?: number;
  callSequence?: number;
  durationMs?: number;
  rejectionCode?: PublishingProgressRejectionCode;
  required?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    costUSD?: number;
  };
}

/** Private call context consumed by the publishing diagnostics wrapper before forwarding. */
export interface InternalProviderProgress {
  turn: number;
  task?: 'persona' | 'moderator' | 'arbiter' | 'classifier' | 'map_reduce_reduce' | 'composed_plan' | 'composed_task';
  lane?: string;
}

export interface PublishingProgressReporter {
  emit(event: PublishingProgressEvent): void;
  instrument(client: ReviewModelClient): ReviewModelClient;
}

type ProgressSink = (fields: Record<string, unknown>) => void;

const SAFE_REJECTION_CODES = new Set<PublishingProgressRejectionCode>([
  'aborted', 'timeout', 'rate_limit', 'transport', 'provider_error', 'malformed_output',
  'configuration', 'budget_exhausted', 'internal_error', 'contract', 'auth', 'unknown', 'invalid_task_output',
  'findings_contract_invalid', 'finding_path_invalid', 'finding_path_not_changed', 'finding_line_invalid',
  'finding_line_not_added', 'finding_line_unanchorable', 'finding_severity_invalid',
]);

const SAFE_FAILURE_CLASSES = new Set([
  'contract', 'timeout', 'budget_exhausted', 'auth', 'rate_limit', 'transport',
  'provider_error', 'malformed_output', 'internal_error',
]);

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : undefined;
}

function safeCount(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER) : undefined;
}

function safeDuration(value: unknown): number | undefined {
  const number = safeCount(value);
  return number === undefined ? undefined : Math.min(number, 86_400_000);
}

function safeCost(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, 1_000_000_000) : undefined;
}

function safeRole(value: unknown): PublishingProgressRole {
  switch (value) {
    case 'persona': case 'moderator': case 'arbiter': case 'classifier':
      return value;
    case 'map-reduce-reduce': case 'map_reduce_reduce':
      return 'map_reduce_reduce';
    case 'composed_plan': case 'composed_task':
      return value;
    default:
      return 'other';
  }
}

function roleOfRequest(request: OpenRouterRequest, internal?: InternalProviderProgress): PublishingProgressRole {
  if (internal?.task) return safeRole(internal.task);
  const role = request.metadata?.role;
  if (role) return safeRole(role);
  return request.persona === 'classifier' ? 'classifier' : 'other';
}

function numericUsage(response: OpenRouterResponse): PublishingProgressEvent['usage'] {
  const raw = (response.usage || {}) as unknown as Record<string, unknown>;
  const promptTokens = safeCount(raw.prompt ?? raw.prompt_tokens) ?? 0;
  const completionTokens = safeCount(raw.completion ?? raw.completion_tokens) ?? 0;
  const reportedTotal = safeCount(raw.total ?? raw.total_tokens);
  const cachedTokens = safeCount(resolveCachedTokens(response.usage)) ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? promptTokens + completionTokens,
    cachedTokens,
    costUSD: safeCost(response.costUSD) ?? 0,
  };
}

export function safePublishingRejectionCode(error: unknown, signal?: AbortSignal): PublishingProgressRejectionCode {
  const isTimeout = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const typedFailureClass = (value as { failureClass?: unknown }).failureClass;
    const name = (value as { name?: unknown }).name;
    return typedFailureClass === 'timeout'
      || name === 'OpenRouterTimeoutError'
      || name === 'PanelDeadlineExceededError';
  };
  // A panel deadline is represented by an aborted signal, but it carries a typed timeout reason.
  // Preserve that distinction before applying the generic caller-cancelled fallback.
  if (isTimeout(error) || isTimeout(signal?.reason)) return 'timeout';
  if (signal?.aborted) return 'aborted';
  if (error && typeof error === 'object') {
    const typedFailureClass = (error as { failureClass?: unknown }).failureClass;
    if (typeof typedFailureClass === 'string' && SAFE_FAILURE_CLASSES.has(typedFailureClass)) {
      switch (typedFailureClass) {
        case 'contract': return 'contract';
        case 'timeout': return 'timeout';
        case 'budget_exhausted': return 'budget_exhausted';
        case 'auth': return 'auth';
        case 'rate_limit': return 'rate_limit';
        case 'transport': return 'transport';
        case 'provider_error': return 'provider_error';
        case 'malformed_output': return 'malformed_output';
        case 'internal_error': return 'internal_error';
      }
    }
    const name = (error as { name?: unknown }).name;
    switch (name) {
      case 'AbortError': return 'aborted';
      case 'OpenRouterTimeoutError': case 'PanelDeadlineExceededError': return 'timeout';
      case 'UpstreamCapacityRejectionError': return 'rate_limit';
      case 'OpenRouterConnectionError': return 'transport';
      case 'OpenRouterResponseError': return 'provider_error';
      case 'PanelFindingsValidationError': case 'PanelStructuredOutputError': return 'malformed_output';
      case 'PanelConfigurationError': return 'configuration';
    }
  }
  return 'unknown';
}

export function findingCorrectionForCode(code: unknown): {
  rejectionCode: PublishingProgressRejectionCode;
  hint: string;
} | undefined {
  switch (code) {
    case 'path_invalid':
      return {
        rejectionCode: 'finding_path_invalid',
        hint: 'Use a non-empty relative path with no absolute prefix or traversal segments; remove the finding if its path cannot be stated exactly.',
      };
    case 'path_not_changed':
      return {
        rejectionCode: 'finding_path_not_changed',
        hint: 'Use the exact path of a file in the supplied changed-file set; remove the finding if the issue is outside those files.',
      };
    case 'line_invalid':
      return {
        rejectionCode: 'finding_line_invalid',
        hint: 'Use a positive integer line number; remove the finding if no exact line can be supplied.',
      };
    case 'line_not_added':
      return {
        rejectionCode: 'finding_line_not_added',
        hint: 'Correct the finding line to an added line in the supplied changed-file diff, or remove the finding if it cannot be anchored.',
      };
    case 'line_unanchorable':
      return {
        rejectionCode: 'finding_line_unanchorable',
        hint: 'The changed-file diff has no line hunk for this path. Remove the finding unless the supplied diff can anchor it to an added line.',
      };
    case 'severity_invalid':
      return {
        rejectionCode: 'finding_severity_invalid',
        hint: 'Use exactly one declared severity value: P0, P1, or P2. Do not relabel or infer severity.',
      };
    case 'contract_invalid':
      return {
        rejectionCode: 'findings_contract_invalid',
        hint: 'Return only findings that satisfy the complete findings contract; remove any finding that cannot be represented validly.',
      };
    default:
      return undefined;
  }
}

/** Finite subtype mapping for validator diagnostics; values never include provider text. */
export function findingRejectionCodeForCode(code: unknown): PublishingProgressRejectionCode {
  switch (code) {
    case 'path_invalid': return 'finding_path_invalid';
    case 'path_not_changed': return 'finding_path_not_changed';
    case 'line_invalid': return 'finding_line_invalid';
    case 'line_not_added': return 'finding_line_not_added';
    case 'line_unanchorable': return 'finding_line_unanchorable';
    case 'severity_invalid': return 'finding_severity_invalid';
    case 'contract_invalid':
    default: return 'findings_contract_invalid';
  }
}

/**
 * Per-execution, fail-soft structured diagnostics. It deliberately accepts only scalar fields and
 * finite reason codes; prompts, provider responses, titles, paths, and error messages have no
 * representation in this contract.
 */
export function createPublishingProgress(
  identity: PublishingProgressIdentity,
  options: { sink?: ProgressSink; now?: () => number } = {},
): PublishingProgressReporter {
  const runId = safeIdentifier(identity.runId);
  const executionAttempt = safeCount(identity.executionAttempt);
  const sink = options.sink || ((fields: Record<string, unknown>) => logger.info('Publishing review progress', fields));
  const now = options.now || Date.now;
  let callSequence = 0;

  const emit = (event: PublishingProgressEvent): void => {
    if (!runId || executionAttempt === undefined || executionAttempt < 1) return;
    const fields: Record<string, unknown> = {
      event: 'review_yeti_publishing_progress',
      runId,
      executionAttempt,
      task: event.task,
      status: event.status,
      ...(event.role ? { role: safeRole(event.role) } : {}),
      ...(safeIdentifier(event.lane) ? { lane: safeIdentifier(event.lane) } : {}),
      ...(safeIdentifier(event.provider) ? { provider: safeIdentifier(event.provider) } : {}),
      ...(safeIdentifier(event.model) ? { model: safeIdentifier(event.model) } : {}),
      ...(safeCount(event.turn) !== undefined ? { turn: safeCount(event.turn) } : {}),
      ...(safeCount(event.callSequence) !== undefined ? { callSequence: safeCount(event.callSequence) } : {}),
      ...(safeDuration(event.durationMs) !== undefined ? { durationMs: safeDuration(event.durationMs) } : {}),
      ...(event.rejectionCode && SAFE_REJECTION_CODES.has(event.rejectionCode) ? { rejectionCode: event.rejectionCode } : {}),
      ...(typeof event.required === 'boolean' ? { required: event.required } : {}),
      ...(event.usage ? { usage: {
        ...(safeCount(event.usage.promptTokens) !== undefined ? { promptTokens: safeCount(event.usage.promptTokens) } : {}),
        ...(safeCount(event.usage.completionTokens) !== undefined ? { completionTokens: safeCount(event.usage.completionTokens) } : {}),
        ...(safeCount(event.usage.totalTokens) !== undefined ? { totalTokens: safeCount(event.usage.totalTokens) } : {}),
        ...(safeCount(event.usage.cachedTokens) !== undefined ? { cachedTokens: safeCount(event.usage.cachedTokens) } : {}),
        ...(safeCost(event.usage.costUSD) !== undefined ? { costUSD: safeCost(event.usage.costUSD) } : {}),
      } } : {}),
    };
    try { sink(fields); } catch { /* diagnostics must never change a review outcome */ }
  };

  return {
    emit,
    instrument(client: ReviewModelClient): ReviewModelClient {
      return {
        complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
          const internal = request.internalProgress;
          // This private field is stripped before the wrapped client sees the request, so it cannot
          // alter an HTTP body or a caller's provider behavior.
          let forwardedRequest = request;
          if (Object.prototype.hasOwnProperty.call(request, 'internalProgress')) {
            const { internalProgress: _internalProgress, ...withoutInternalProgress } = request;
            forwardedRequest = withoutInternalProgress;
          }
          const callSequenceForRun = ++callSequence;
          const startedAt = now();
          const role = roleOfRequest(request, internal);
          const lane = safeIdentifier(internal?.lane || request.persona);
          const diagnosticSignal = request.signal;
          const provider = safeIdentifier(request.providerId);
          const model = safeIdentifier(request.model);
          const turn = safeCount(internal?.turn) || 1;
          const common = {
            task: 'provider_call' as const,
            role,
            ...(lane ? { lane } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            turn,
            callSequence: callSequenceForRun,
          };
          emit({ ...common, status: 'started' });
          let settled = false;
          const finish = (status: 'completed' | 'failed' | 'aborted', extras: Partial<PublishingProgressEvent> = {}) => {
            if (settled) return;
            settled = true;
            emit({ ...common, ...extras, status, durationMs: Math.max(0, now() - startedAt) });
          };
          const onAbort = () => finish('aborted', {
            rejectionCode: safePublishingRejectionCode(undefined, diagnosticSignal),
          });
          diagnosticSignal?.addEventListener('abort', onAbort, { once: true });
          if (diagnosticSignal?.aborted) onAbort();

          let pending: Promise<OpenRouterResponse>;
          try {
            pending = client.complete(forwardedRequest);
          } catch (error) {
            finish(diagnosticSignal?.aborted ? 'aborted' : 'failed', {
              rejectionCode: safePublishingRejectionCode(error, diagnosticSignal),
            });
            diagnosticSignal?.removeEventListener('abort', onAbort);
            throw error;
          }
          return pending.then((response) => {
            finish('completed', {
              usage: numericUsage(response),
            });
            return response;
          }, (error: unknown) => {
            finish(diagnosticSignal?.aborted ? 'aborted' : 'failed', {
              rejectionCode: safePublishingRejectionCode(error, diagnosticSignal),
            });
            throw error;
          }).finally(() => diagnosticSignal?.removeEventListener('abort', onAbort));
        },
      };
    },
  };
}
