import {
  OpenRouterResponseError,
  observedHttpStatusOf,
  resolveCachedTokens,
  type OpenRouterRequest,
  type OpenRouterResponse,
  type ReviewModelClient,
} from '../gateway/openRouterClient';
import type { WorkerFailureClass } from '../types/workerFailure';
import { logger } from '../utils/logger';
import { deriveResponseUsageAvailability, normalizeOperationalTelemetry, operationalTelemetryEventSchema, type OperationalTelemetry } from '../review/workerCompletion';
import { classifyProviderResponseStatus } from '../review/laneInfrastructure';

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
  responseStatus?: number;
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
  snapshot?(): OperationalTelemetry | undefined;
}

type ProgressSink = (fields: Record<string, unknown>) => void;

const SAFE_REJECTION_CODES: Readonly<Record<PublishingProgressRejectionCode, true>> = {
  aborted: true,
  timeout: true,
  rate_limit: true,
  transport: true,
  provider_error: true,
  malformed_output: true,
  configuration: true,
  budget_exhausted: true,
  internal_error: true,
  contract: true,
  auth: true,
  unknown: true,
  invalid_task_output: true,
  findings_contract_invalid: true,
  finding_path_invalid: true,
  finding_path_not_changed: true,
  finding_line_invalid: true,
  finding_line_not_added: true,
  finding_line_unanchorable: true,
  finding_severity_invalid: true,
};

const SAFE_FAILURE_REJECTION_CODES: Readonly<Record<WorkerFailureClass, PublishingProgressRejectionCode>> = {
  contract: 'contract',
  timeout: 'timeout',
  budget_exhausted: 'budget_exhausted',
  auth: 'auth',
  rate_limit: 'rate_limit',
  transport: 'transport',
  provider_error: 'provider_error',
  malformed_output: 'malformed_output',
  internal_error: 'internal_error',
};

function isSafePublishingRejectionCode(value: unknown): value is PublishingProgressRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SAFE_REJECTION_CODES, value);
}

function workerFailureRejectionCode(value: unknown): PublishingProgressRejectionCode | undefined {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SAFE_FAILURE_REJECTION_CODES, value)) return undefined;
  return SAFE_FAILURE_REJECTION_CODES[value as WorkerFailureClass];
}

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

function safeResponseStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function responseStatusOf(error: unknown): number | undefined {
  return safeResponseStatus(observedHttpStatusOf(error)?.status);
}

function providerFailureProgressFields(error: unknown, signal?: AbortSignal): Pick<PublishingProgressEvent, 'rejectionCode' | 'responseStatus'> {
  const responseStatus = signal?.aborted ? undefined : responseStatusOf(error);
  return {
    rejectionCode: safePublishingRejectionCode(error, signal),
    ...(responseStatus !== undefined ? { responseStatus } : {}),
  };
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
  try {
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
  } catch { return {}; }
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
    const failureRejectionCode = workerFailureRejectionCode(typedFailureClass);
    if (failureRejectionCode) return failureRejectionCode;
    if (error instanceof OpenRouterResponseError) {
      return classifyProviderResponseStatus(responseStatusOf(error)) ?? 'provider_error';
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
        hint: 'Use exactly one declared severity value: P0, P1, P2, P3, or NIT. Do not relabel or infer severity.',
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
  return findingCorrectionForCode(code)?.rejectionCode ?? 'findings_contract_invalid';
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
  let panelStartedAt: number | undefined;
  let panelFinishedAt: number | undefined;
  const emptyPhase=()=>({started:0,completed:0,failed:0,aborted:0,skipped:0,blocked:0,rejected:0});
  const observed: OperationalTelemetry = {
    version:'OperationalTelemetry.v1', basis:'observed_worker_client', cause:'unknown', eventCount:0, eventsDropped:0, recentEvents:[],
    phaseCounts:{panel:emptyPhase(),persona_lane:emptyPhase(),composed_plan:emptyPhase(),composed_task:emptyPhase(),provider_call:emptyPhase(),provider_output:emptyPhase()},
    providerCalls:{started:0,completed:0,failed:0,aborted:0,inflight:0},
    responseUsage:{availability:'unknown',responses:0,samples:{promptTokens:0,completionTokens:0,totalTokens:0,cachedTokens:0,costUSD:0},totals:{}},
    panel:{invoked:false},
  };
  // Only returned numeric scalars are known. Existing log/ledger zero defaults do not establish availability.
  const observeUsage = (response: OpenRouterResponse): void => {
    try {
      const raw=(response.usage || {}) as unknown as Record<string, unknown>;
      const values={promptTokens:raw.prompt ?? raw.prompt_tokens, completionTokens:raw.completion ?? raw.completion_tokens,
        totalTokens:raw.total ?? raw.total_tokens, cachedTokens:raw.cachedTokens ?? raw.cached ?? raw.cached_tokens ?? (raw.prompt_tokens_details as any)?.cached_tokens ?? raw.cache_read_input_tokens,
        costUSD:response.costUSD};
      for(const key of Object.keys(values) as Array<keyof typeof values>){
        const n=values[key]; const max=key==='costUSD'?1_000_000_000:Number.MAX_SAFE_INTEGER;
        if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>max||(key!=='costUSD'&&!Number.isSafeInteger(n)))continue;
        const total=(observed.responseUsage.totals[key] ?? 0)+n;
        if(total>max)continue;
        observed.responseUsage.samples[key]++; observed.responseUsage.totals[key]=total;
      }
    } catch { /* untrusted response metadata cannot affect completion */ }
  };
  const observe = (event: PublishingProgressEvent, includeObservedResponseStatus: boolean): void => {
    try {
      const candidate = { task:event.task, status:event.status,
        ...(event.role ? {role:safeRole(event.role)}:{}),
        ...(typeof event.turn==='number'&&Number.isSafeInteger(event.turn)&&event.turn>=0?{turn:event.turn}:{}),
        ...(typeof event.callSequence==='number'&&Number.isSafeInteger(event.callSequence)&&event.callSequence>=0?{callSequence:event.callSequence}:{}),
        ...(typeof event.durationMs==='number'&&Number.isSafeInteger(event.durationMs)&&event.durationMs>=0&&event.durationMs<=86_400_000?{durationMs:event.durationMs}:{}),
        ...(includeObservedResponseStatus&&safeResponseStatus(event.responseStatus)!==undefined?{responseStatus:safeResponseStatus(event.responseStatus)}:{}),
        ...(isSafePublishingRejectionCode(event.rejectionCode)?{rejectionCode:event.rejectionCode}:{}),
      };
      const parsed=operationalTelemetryEventSchema.safeParse(candidate);
      // Validate enums with the shared schema before retaining anything.
      if(!parsed.success)return;
      observed.eventCount++; observed.phaseCounts[parsed.data.task][parsed.data.status]++;
      observed.recentEvents.push(parsed.data);
      if(observed.recentEvents.length>16){observed.recentEvents.shift();observed.eventsDropped++;}
      if(event.task==='panel'&&event.status==='started'){observed.panel.invoked=true;panelStartedAt=now();}
      if(event.task==='panel'&&['completed','failed','aborted'].includes(event.status)&&panelStartedAt!==undefined&&panelFinishedAt===undefined)panelFinishedAt=now();
    } catch { /* observations are optional */ }
  };
  const snapshot = (): OperationalTelemetry | undefined => {
    try {
      const copy=JSON.parse(JSON.stringify(observed)) as OperationalTelemetry;
      const samples=Object.values(copy.responseUsage.samples);
      copy.responseUsage.availability=deriveResponseUsageAvailability(copy.responseUsage.responses,samples);
      if(panelStartedAt!==undefined){const elapsed=(panelFinishedAt ?? now())-panelStartedAt;if(Number.isSafeInteger(elapsed)&&elapsed>=0&&elapsed<=86_400_000)copy.panel.wallClockMs=elapsed;}
      return normalizeOperationalTelemetry(copy);
    } catch { return undefined; }
  };

  const emitEvent = (event: PublishingProgressEvent, allowObservedResponseStatus = false): void => {
    try {
    if (!runId || executionAttempt === undefined || executionAttempt < 1) return;
    const includeObservedResponseStatus = allowObservedResponseStatus
      && event.task === 'provider_call'
      && event.status === 'failed';
    observe(event, includeObservedResponseStatus);
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
      ...(includeObservedResponseStatus && safeResponseStatus(event.responseStatus) !== undefined
        ? { responseStatus: safeResponseStatus(event.responseStatus) }
        : {}),
      ...(isSafePublishingRejectionCode(event.rejectionCode) ? { rejectionCode: event.rejectionCode } : {}),
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
    } catch { /* unsafe optional event metadata is ignored */ }
  };
  // Public emits are caller-controlled; only the instrumented gateway failure path may retain
  // status metadata after extracting it from trusted HTTP provenance.
  const emit = (event: PublishingProgressEvent): void => emitEvent(event);

  const reporter: PublishingProgressReporter = {
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
          observed.providerCalls.started++; observed.providerCalls.inflight++;
          emit({ ...common, status: 'started' });
          let settled = false;
          const finish = (
            status: 'completed' | 'failed' | 'aborted',
            extras: Partial<PublishingProgressEvent> = {},
            includeObservedResponseStatus = false,
          ) => {
            if (settled) return;
            settled = true;
            observed.providerCalls.inflight--; observed.providerCalls[status]++;
            if(status==='completed')observed.responseUsage.responses++;
            emitEvent({ ...common, ...extras, status, durationMs: Math.max(0, now() - startedAt) }, includeObservedResponseStatus);
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
              ...providerFailureProgressFields(error, diagnosticSignal),
            }, true);
            diagnosticSignal?.removeEventListener('abort', onAbort);
            throw error;
          }
          return pending.then((response) => {
            if(!settled)observeUsage(response);
            finish('completed', {
              usage: numericUsage(response),
            });
            return response;
          }, (error: unknown) => {
            finish(diagnosticSignal?.aborted ? 'aborted' : 'failed', {
              ...providerFailureProgressFields(error, diagnosticSignal),
            }, true);
            throw error;
          }).finally(() => diagnosticSignal?.removeEventListener('abort', onAbort));
        },
      };
    },
  };
  // Preserve the existing enumerable panelRunner contract; this is local observation only.
  Object.defineProperty(reporter, 'snapshot', {value:snapshot, enumerable:false});
  return reporter;
}
