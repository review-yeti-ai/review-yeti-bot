import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { FetchImplementation, OpenRouterRequest, OpenRouterResponse, TokensUsed } from '../gateway/openRouterClient';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../review/groundedEvidenceV2';
import {
  NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES,
  NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE,
  NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION,
  type NormalEngineProviderCaptureBinding,
  type NormalEngineProviderCaptureHeaderName,
  type NormalEngineProviderCaptureRequest,
  type NormalEngineProviderCaptureRouteBinding,
  type NormalEngineProviderCaptureRouteBindingInput,
  type NormalEngineProviderCaptureV1,
  type NormalEngineProviderCaptureValue,
  type NormalEngineQualificationProviderCall,
} from './normalEngineQualification';
import { z } from 'zod';

export { NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES } from './normalEngineQualification';
export type { NormalEngineProviderCaptureBinding, NormalEngineProviderCaptureV1 } from './normalEngineQualification';

interface LogicalCall {
  request: OpenRouterRequest;
  startedAt: string;
  startedMs: number;
  physicalCalls: NormalEngineQualificationProviderCall[];
  routeBinding?: NormalEngineProviderCaptureRouteBindingInput;
}

export interface NormalEngineQualificationProviderRunContext {
  /** Facts from this exact verifier request context; never reconstructed from the prompt or model alias. */
  routeBinding?: NormalEngineProviderCaptureRouteBindingInput;
}

export interface NormalEngineQualificationPrivateProviderIdentifiers {
  callerRequestId: string;
  bifrostLogRequestId: string;
  upstreamResponseRequestId: string | null;
}

interface CapturedPhysicalRequest extends NormalEngineProviderCaptureRequest {
  startedMs: number;
  privateIds: NormalEngineQualificationPrivateProviderIdentifiers;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeIdentifier(value: unknown, limit = 120): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= limit && /^[A-Za-z0-9._:/+-]+$/u.test(normalized)
    ? normalized : null;
}

function safeUuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value : null;
}

function providerPreference(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const preference: Record<string, string[]> = {};
  for (const key of ['only', 'order'] as const) {
    const raw = source[key];
    if (!Array.isArray(raw)) continue;
    const entries = raw.map((item) => safeIdentifier(item, 80)).filter((item): item is string => item !== null).slice(0, 16);
    if (entries.length > 0) preference[key] = entries;
  }
  if (Object.keys(preference).length === 0) return null;
  const serialized = JSON.stringify(preference);
  return serialized.length <= 256 ? serialized : 'present_unrecorded';
}

function tokenUsage(value: unknown): NormalEngineQualificationProviderCall['tokenUsage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<TokensUsed>;
  const read = (number: unknown): number | null => typeof number === 'number'
    && Number.isSafeInteger(number) && number >= 0 ? number : null;
  const prompt = read(source.prompt);
  const completion = read(source.completion);
  const total = read(source.total);
  return prompt === null && completion === null && total === null ? null : { prompt, completion, total };
}

function responseProvider(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const metadata = source.openrouter_metadata as Record<string, unknown> | undefined;
  const extraFields = source.extra_fields as Record<string, unknown> | undefined;
  const routing = extraFields?.routing_info as Record<string, unknown> | undefined;
  return safeIdentifier(source.provider) ?? safeIdentifier(metadata?.provider_name) ?? safeIdentifier(routing?.provider);
}

function sanitizeFetchFailure(error: unknown): NormalEngineQualificationProviderCall['fetchFailureClass'] {
  if (error instanceof Error && /timeout|deadline/iu.test(error.name)) return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  const code = String((error as { cause?: { code?: unknown } })?.cause?.code || '').toUpperCase();
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return 'connection';
  return 'other';
}

function available<T>(value: T): NormalEngineProviderCaptureValue<T> {
  return { availability: 'available', value, unavailableReason: null };
}

function unavailable<T = never>(reason: string): NormalEngineProviderCaptureValue<T> {
  return { availability: 'unavailable', value: null, unavailableReason: reason };
}

function captureBoundString(value: unknown, limit: number, missingReason: string): NormalEngineProviderCaptureValue<string> {
  const result = safeIdentifier(value, limit);
  return result === null ? unavailable(missingReason) : available(result);
}

function captureEnum<T extends string>(value: unknown, allowed: readonly T[], missingReason: string): NormalEngineProviderCaptureValue<T> {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? available(value as T) : unavailable(missingReason);
}

function captureRouteBinding(input?: NormalEngineProviderCaptureRouteBindingInput): NormalEngineProviderCaptureRouteBinding {
  const missing = 'route_binding_not_provided_by_actual_request_context';
  const has = (key: keyof NormalEngineProviderCaptureRouteBindingInput): boolean => Boolean(input && Object.hasOwn(input, key));
  const captureIfPresent = <T>(key: keyof NormalEngineProviderCaptureRouteBindingInput, value: unknown,
    transform: (raw: unknown) => NormalEngineProviderCaptureValue<T>): NormalEngineProviderCaptureValue<T> =>
    !has(key) ? unavailable(missing) : transform(value);
  return {
    findingFingerprint: captureIfPresent('findingFingerprint', input?.findingFingerprint,
      (raw) => captureBoundString(raw, 500, 'route_binding_value_invalid')),
    severity: captureIfPresent('severity', input?.severity,
      (raw) => captureEnum(raw, ['P0', 'P1', 'P2', 'P3', 'NIT'], 'route_binding_value_invalid')),
    purpose: captureIfPresent('purpose', input?.purpose,
      (raw) => captureEnum(raw, ['primary', 'disputed-blocker-recheck'], 'route_binding_value_invalid')),
    requestedRole: captureIfPresent('requestedRole', input?.requestedRole,
      (raw) => captureEnum(raw, ['primary', 'disputed-blocker-adjudicator'], 'route_binding_value_invalid')),
    appliedRole: captureIfPresent('appliedRole', input?.appliedRole,
      (raw) => captureEnum(raw, ['primary', 'disputed-blocker-adjudicator'], 'route_binding_value_invalid')),
    configuredAlternateModel: captureIfPresent('configuredAlternateModel', input?.configuredAlternateModel,
      (raw) => raw === null ? available(null) : captureBoundString(raw, 200, 'route_binding_value_invalid')),
    selectedModel: captureIfPresent('selectedModel', input?.selectedModel,
      (raw) => captureBoundString(raw, 200, 'route_binding_value_invalid')),
  };
}

function capturedRequestBody(body: unknown): NormalEngineProviderCaptureRequest['body'] {
  if (typeof body !== 'string') {
    return { status: 'unavailable', sha256: null, byteCount: null,
      unavailableReason: body === null || body === undefined ? 'init_body_absent' : 'init_body_not_string' };
  }
  return { status: 'captured', sha256: digest(body), byteCount: Buffer.byteLength(body, 'utf8'), unavailableReason: null };
}

function captureResponseHeaders(headers: Headers | undefined, unavailableReason: string):
  NormalEngineProviderCaptureRequest['responseHeaders'] {
  const captured = {} as NormalEngineProviderCaptureRequest['responseHeaders'];
  for (const name of NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES) {
    const raw = headers?.get(name) ?? null;
    if (raw === null) captured[name] = unavailable(headers ? 'response_header_absent' : unavailableReason);
    else {
      const sanitized = safeIdentifier(raw, 256);
      captured[name] = sanitized === null ? unavailable('response_header_value_invalid') : available(sanitized);
    }
  }
  return captured;
}

function requestEffort(request: OpenRouterRequest): unknown {
  if (request.reasoningEffort !== undefined) return request.reasoningEffort;
  const reasoning = request.reasoning;
  return reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)
    ? (reasoning as Record<string, unknown>).effort : undefined;
}

const captureValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) => z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('available'), value: valueSchema, unavailableReason: z.null() }).strict(),
  z.object({ availability: z.literal('unavailable'), value: z.null(), unavailableReason: z.string().min(1).max(200) }).strict(),
]);

const captureStringSchema = captureValueSchema(z.string().min(1).max(500));
const captureModelSchema = captureValueSchema(z.string().min(1).max(200));
const captureSeveritySchema = captureValueSchema(z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']));
const capturePurposeSchema = captureValueSchema(z.enum(['primary', 'disputed-blocker-recheck']));
const captureRoleSchema = captureValueSchema(z.enum(['primary', 'disputed-blocker-adjudicator']));
const captureNullableModelSchema = captureValueSchema(z.string().min(1).max(200).nullable());
const captureRequestIdSchema = captureValueSchema(z.string().regex(/^[a-f0-9]{64}$/u));
const captureHttpStatusSchema = captureValueSchema(z.number().int().min(100).max(599).safe());
const captureFailureClassSchema = captureValueSchema(z.enum(['connection', 'timeout', 'aborted', 'http_error', 'other']).nullable());
const captureDateSchema = captureValueSchema(z.string().datetime());
const captureDurationSchema = captureValueSchema(z.number().int().nonnegative().safe());
const captureHeaderShape = Object.fromEntries(NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES.map((name) => [name, captureValueSchema(z.string().min(1).max(256))])) as unknown as
  Record<NormalEngineProviderCaptureHeaderName, typeof captureValueSchema extends (...args: any[]) => infer R ? R : never>;
const captureHeadersSchema = z.object(captureHeaderShape).strict();
const captureRouteBindingSchema = z.object({
  findingFingerprint: captureStringSchema,
  severity: captureSeveritySchema,
  purpose: capturePurposeSchema,
  requestedRole: captureRoleSchema,
  appliedRole: captureRoleSchema,
  configuredAlternateModel: captureNullableModelSchema,
  selectedModel: captureModelSchema,
}).strict();

const captureRequestSchema = z.object({
  physicalOrdinal: z.number().int().positive().safe(),
  dispatchStartedAt: z.string().datetime(),
  logicalCallIdSha256: captureRequestIdSchema,
  cidSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  body: z.object({
    status: z.enum(['captured', 'unavailable']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    byteCount: z.number().int().nonnegative().safe().nullable(),
    unavailableReason: z.string().min(1).max(100).nullable(),
  }).strict().superRefine((body, context) => {
    const captured = body.status === 'captured';
    if (captured !== (body.sha256 !== null && body.byteCount !== null && body.unavailableReason === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'provider request body digest metadata is inconsistent' });
    }
    if (!captured && (body.sha256 !== null || body.byteCount !== null || body.unavailableReason === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['unavailableReason'], message: 'unavailable body capture requires a reason' });
    }
  }),
  requestedModel: captureModelSchema,
  requestedEffort: captureValueSchema(z.string().min(1).max(32)),
  outputCap: captureValueSchema(z.number().int().positive().safe()),
  status: z.enum(['dispatching', 'response_received', 'fetch_failed']),
  httpStatus: captureHttpStatusSchema,
  responseHeaders: captureHeadersSchema,
  fetchFailureClass: captureFailureClassSchema,
  routeBinding: captureRouteBindingSchema,
  completedAt: captureDateSchema,
  durationMs: captureDurationSchema,
}).strict().superRefine((request, context) => {
  const noResponseHeadersCaptured = Object.values(request.responseHeaders)
    .every((header) => header.availability === 'unavailable');
  if (request.status === 'response_received') {
    if (request.httpStatus.availability !== 'available' || request.completedAt.availability !== 'available'
      || request.durationMs.availability !== 'available') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'returned provider responses require status and completion timing' });
    }
    if (request.httpStatus.availability === 'available' && request.fetchFailureClass.availability === 'available') {
      const expected = request.httpStatus.value >= 400 ? 'http_error' : null;
      if (request.fetchFailureClass.value !== expected) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['fetchFailureClass'], message: 'provider HTTP outcome classification is inconsistent' });
      }
    }
  } else if (request.status === 'fetch_failed') {
    if (request.httpStatus.availability !== 'unavailable' || request.completedAt.availability !== 'available'
      || request.durationMs.availability !== 'available' || request.fetchFailureClass.availability !== 'available'
      || request.fetchFailureClass.value === null || request.fetchFailureClass.value === 'http_error'
      || !noResponseHeadersCaptured) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'failed fetch metadata is incomplete or misclassified' });
    }
  } else if (request.httpStatus.availability !== 'unavailable' || request.completedAt.availability !== 'unavailable'
    || request.durationMs.availability !== 'unavailable' || request.fetchFailureClass.availability !== 'unavailable'
    || !noResponseHeadersCaptured) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'dispatching requests cannot have a terminal outcome' });
  }
});

export const normalEngineProviderCaptureV1Schema = z.object({
  schemaVersion: z.literal(NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION),
  purpose: z.literal(NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE),
  runId: z.string().regex(/^nq_[a-f0-9]{32}$/u),
  phase: z.enum(['single', 'repair-introduction', 'repair-head', 'same-head-recheck']),
  caseId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/u),
  runtime: z.object({
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
    workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    runtimeManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  target: z.object({
    kind: z.literal('public-synthetic-fixture'),
    repositoryId: z.number().int().positive().safe(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    prNumber: z.number().int().positive().safe(),
    caseId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/u),
    bundleVersion: z.string().min(1).max(100),
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/u),
    headSha: z.string().regex(/^[a-f0-9]{40}$/u),
    diffSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  policy: z.object({
    targetRepository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    selectionPurpose: z.literal('qualification-only-target-binding'),
    configurationVariant: z.enum(['prepared-policy-default-v1', 'configured-disputed-blocker-adjudicator-v1']),
    source: z.object({
      repositoryId: z.number().int().positive().safe(),
      owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
      ref: z.string().regex(/^[a-f0-9]{40}$/u),
      path: z.string().min(1).max(512).refine((value) => !value.startsWith('/')
        && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
        && !/[\\\u0000-\u001f\u007f]/u.test(value)),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict(),
    effectivePolicyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    effectiveConfigDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  groundedEvidenceSemanticsVersion: z.literal(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION),
  requests: z.array(captureRequestSchema).max(10_000),
}).strict().superRefine((capture, context) => {
  if (capture.caseId !== capture.target.caseId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['target', 'caseId'], message: 'provider capture case identity is inconsistent' });
  }
  if (capture.policy.targetRepository !== `${capture.policy.source.owner}/${capture.policy.source.repo}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['policy', 'targetRepository'], message: 'provider capture policy binding is inconsistent' });
  }
  if (capture.requests.some((request, index) => request.physicalOrdinal !== index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requests'], message: 'provider capture requests must be in contiguous dispatch order' });
  }
});

/** Captures request identity and allowlisted response headers without reading response content. */
export class NormalEngineQualificationProviderAttestor {
  private readonly activeCall = new AsyncLocalStorage<LogicalCall>();
  private readonly calls: NormalEngineQualificationProviderCall[] = [];
  private readonly privateIdRows: NormalEngineQualificationPrivateProviderIdentifiers[] = [];
  private readonly captureRequests: CapturedPhysicalRequest[] = [];
  private nextPhysicalOrdinal = 0;
  private captureBinding: NormalEngineProviderCaptureBinding | undefined;
  private captureContextLocked = false;

  constructor(
    private readonly fetchImplementation: FetchImplementation = (input, init) => globalThis.fetch(input, init),
    private readonly requestIdFactory: () => string = randomUUID,
  ) {}

  /** Binds the qualification identity once, before any logical provider operation or fetch starts. */
  bindCaptureContext(binding: NormalEngineProviderCaptureBinding): void {
    if (this.captureContextLocked) {
      throw new Error('normal_engine_qualification_provider_capture_context_must_be_bound_before_dispatch');
    }
    if (this.captureBinding) {
      throw new Error('normal_engine_qualification_provider_capture_context_already_bound');
    }
    this.captureBinding = validatedCaptureBinding(binding);
  }

  async run<T>(request: OpenRouterRequest, operation: () => Promise<T>, runContext: NormalEngineQualificationProviderRunContext = {}): Promise<T> {
    this.captureContextLocked = true;
    const context: LogicalCall = {
      request, startedAt: new Date().toISOString(), startedMs: Date.now(), physicalCalls: [],
      ...(runContext.routeBinding ? { routeBinding: { ...runContext.routeBinding } } : {}),
    };
    try {
      const result = await this.activeCall.run(context, operation);
      const finalCall = context.physicalCalls[context.physicalCalls.length - 1];
      if (finalCall && result && typeof result === 'object') {
        const response = result as Partial<OpenRouterResponse>;
        finalCall.responseReportedModel = safeIdentifier(response.model, 256);
        finalCall.responseReportedProvider = responseProvider(response.raw);
        finalCall.tokenUsage = tokenUsage(response.usage);
        finalCall.completedAt = new Date().toISOString();
        finalCall.durationMs = Math.max(0, Date.now() - context.startedMs);
      }
      return result;
    } catch (error) {
      const finalCall = context.physicalCalls[context.physicalCalls.length - 1];
      if (finalCall) {
        finalCall.fetchFailureClass ||= sanitizeFetchFailure(error);
        finalCall.completedAt = new Date().toISOString();
        finalCall.durationMs = Math.max(0, Date.now() - context.startedMs);
      }
      throw error;
    } finally {
      this.calls.push(...context.physicalCalls.map((call) => structuredClone(call)));
    }
  }

  readonly fetch: FetchImplementation = async (input, init) => {
    this.captureContextLocked = true;
    const context = this.activeCall.getStore();
    if (!context) throw new Error('normal_engine_qualification_unbound_provider_call');
    const requestId = safeUuid(this.requestIdFactory());
    if (!requestId) throw new Error('normal_engine_qualification_request_id_invalid');
    const headers = new Headers(init?.headers);
    headers.set('x-request-id', requestId);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const ordinal = ++this.nextPhysicalOrdinal;
    const routeBinding = captureRouteBinding(context.routeBinding);
    const requestCapture: CapturedPhysicalRequest = {
      physicalOrdinal: ordinal,
      dispatchStartedAt: startedAt,
      logicalCallIdSha256: unavailable('logical_call_id_not_exposed_by_actual_request_context'),
      cidSha256: digest(requestId),
      body: capturedRequestBody(init?.body),
      requestedModel: captureBoundString(context.request.model, 200, 'requested_model_not_available_in_request_context'),
      requestedEffort: captureBoundString(requestEffort(context.request), 32, 'requested_effort_not_available_in_request_context'),
      outputCap: typeof context.request.maxTokens === 'number' && Number.isSafeInteger(context.request.maxTokens)
        && context.request.maxTokens > 0
        ? available(context.request.maxTokens) : unavailable('requested_output_cap_not_available_in_request_context'),
      status: 'dispatching',
      httpStatus: unavailable('provider_response_not_received'),
      responseHeaders: captureResponseHeaders(undefined, 'provider_response_not_received'),
      fetchFailureClass: unavailable('provider_fetch_not_completed'),
      routeBinding,
      completedAt: unavailable('provider_fetch_not_completed'),
      durationMs: unavailable('provider_fetch_not_completed'),
      startedMs,
      privateIds: { callerRequestId: requestId, bifrostLogRequestId: requestId, upstreamResponseRequestId: null },
    };

    const requestEffortValue = requestEffort(context.request);
    const providerPreferenceValue = providerPreference(context.request.provider);
    const requestedAlias = safeIdentifier(context.request.model, 256) ?? 'unknown';
    const call: NormalEngineQualificationProviderCall = {
      clientRequestIdSha256: digest(requestId),
      bifrostLogRequestIdSha256: digest(requestId),
      upstreamResponseRequestIdSha256: null,
      requestedAlias,
      requestedProviderPreference: providerPreferenceValue,
      requestedEffort: safeIdentifier(requestEffortValue, 32),
      outputCap: typeof context.request.maxTokens === 'number' && Number.isSafeInteger(context.request.maxTokens)
        && context.request.maxTokens > 0 ? context.request.maxTokens : null,
      stream: context.request.stream ?? null,
      httpStatus: null,
      responseReportedModel: null,
      responseReportedProvider: null,
      responseHeaderRouteHints: [],
      tokenUsage: null,
      startedAt,
      headersAt: null,
      completedAt: null,
      durationMs: null,
      fetchFailureClass: null,
      contentPersisted: false,
      gatewayEvidence: {
        status: 'not_available', provider: null, originalModel: null, resolvedModel: null,
        fallbackIndex: null, requestType: null, upstreamLatencyMs: null,
        routingInfo: {
          provider: null, model: null, isFallback: null, primaryProvider: null, primaryModel: null,
          serverSideFallbackModel: null, aliasModelId: null, aliasModelName: null, aliasModelFamily: null,
        },
        exactLogRowStatus: 'not_available', parentRequestIdSha256: null, servedModel: null,
        serviceTier: null, speed: null, inferenceGeo: null,
      },
    };
    context.physicalCalls.push(call);
    this.captureRequests.push(requestCapture);
    this.privateIdRows.push(requestCapture.privateIds);

    let response: Response;
    try {
      response = await this.fetchImplementation(input, { ...init, headers });
    } catch (error) {
      call.headersAt = null;
      call.fetchFailureClass = sanitizeFetchFailure(error);
      call.completedAt = new Date().toISOString();
      call.durationMs = Math.max(0, Date.now() - startedMs);
      requestCapture.status = 'fetch_failed';
      requestCapture.httpStatus = unavailable('provider_fetch_failed_before_response');
      requestCapture.responseHeaders = captureResponseHeaders(undefined, 'provider_fetch_failed_before_response');
      requestCapture.fetchFailureClass = available(sanitizeFetchFailure(error));
      requestCapture.completedAt = available(call.completedAt);
      requestCapture.durationMs = available(call.durationMs);
      throw error;
    }

    const responseStatus = Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status : null;
    call.httpStatus = responseStatus;
    call.headersAt = new Date().toISOString();
    const upstreamResponseRequestId = safeUuid(response.headers.get('x-request-id'));
    if (upstreamResponseRequestId) {
      call.upstreamResponseRequestIdSha256 = digest(upstreamResponseRequestId);
      requestCapture.privateIds.upstreamResponseRequestId = upstreamResponseRequestId;
    }
    call.gatewayEvidence = {
      status: hasBifrostRoutingHeaders(response.headers) ? 'headers_unverified' : 'not_available',
      provider: safeIdentifier(response.headers.get('x-bifrost-provider')),
      originalModel: safeIdentifier(response.headers.get('x-bifrost-original-model'), 256),
      resolvedModel: safeIdentifier(response.headers.get('x-bifrost-resolved-model'), 256),
      fallbackIndex: parseNonnegativeInteger(response.headers.get('x-bifrost-fallback-index')),
      requestType: safeIdentifier(response.headers.get('x-bifrost-request-type')),
      upstreamLatencyMs: parseNonnegativeInteger(response.headers.get('x-bifrost-upstream-latency-ms')),
      routingInfo: {
        provider: safeIdentifier(response.headers.get('x-bifrost-routing-info-provider')),
        model: safeIdentifier(response.headers.get('x-bifrost-routing-info-model'), 256),
        isFallback: safeIdentifier(response.headers.get('x-bifrost-routing-info-is-fallback'), 16),
        primaryProvider: safeIdentifier(response.headers.get('x-bifrost-routing-info-primary-provider')),
        primaryModel: safeIdentifier(response.headers.get('x-bifrost-routing-info-primary-model'), 256),
        serverSideFallbackModel: safeIdentifier(response.headers.get('x-bifrost-routing-info-server-side-fallback-model'), 256),
        aliasModelId: safeIdentifier(response.headers.get('x-bifrost-routing-info-alias-model-id'), 256),
        aliasModelName: safeIdentifier(response.headers.get('x-bifrost-routing-info-alias-model-name'), 256),
        aliasModelFamily: safeIdentifier(response.headers.get('x-bifrost-routing-info-alias-model-family'), 256),
      },
      exactLogRowStatus: 'not_available', parentRequestIdSha256: null, servedModel: null,
      serviceTier: null, speed: null, inferenceGeo: null,
    };
    if (responseStatus !== null) requestCapture.httpStatus = available(responseStatus);
    requestCapture.status = 'response_received';
    requestCapture.responseHeaders = captureResponseHeaders(response.headers, 'provider_response_not_received');
    requestCapture.fetchFailureClass = available(responseStatus !== null && responseStatus >= 400 ? 'http_error' : null);
    requestCapture.completedAt = available(new Date().toISOString());
    requestCapture.durationMs = available(Math.max(0, Date.now() - startedMs));
    call.completedAt = requestCapture.completedAt.value!;
    call.durationMs = requestCapture.durationMs.value!;
    if (responseStatus !== null && responseStatus >= 400) call.fetchFailureClass = 'http_error';
    return response;
  };

  snapshot(): NormalEngineQualificationProviderCall[] {
    return this.calls.map((call) => structuredClone(call));
  }

  /** Exact UUIDs remain private until the owning runner writes its mode-0600 sidecar. */
  privateIdentifiers(): NormalEngineQualificationPrivateProviderIdentifiers[] {
    return this.privateIdRows.map((row) => ({ ...row }));
  }

  /** Returns strict metadata-only capture rows ordered by dispatch start from the pre-dispatch identity snapshot. */
  getCapture(binding?: NormalEngineProviderCaptureBinding): NormalEngineProviderCaptureV1 {
    if (!this.captureBinding) {
      throw new Error('normal_engine_qualification_provider_capture_context_not_bound_before_dispatch');
    }
    if (binding && JSON.stringify(validatedCaptureBinding(binding)) !== JSON.stringify(this.captureBinding)) {
      throw new Error('normal_engine_qualification_provider_capture_binding_mismatch');
    }
    const capture = {
      schemaVersion: NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION,
      purpose: NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE,
      ...structuredClone(this.captureBinding),
      requests: this.captureRequests.map(({ startedMs: _startedMs, privateIds: _privateIds, ...row }) => structuredClone(row))
        .sort((left, right) => left.physicalOrdinal - right.physicalOrdinal),
    };
    return normalEngineProviderCaptureV1Schema.parse(capture);
  }
}

function validatedCaptureBinding(binding: NormalEngineProviderCaptureBinding): NormalEngineProviderCaptureBinding {
  const parsed = normalEngineProviderCaptureV1Schema.parse({
    schemaVersion: NORMAL_ENGINE_PROVIDER_CAPTURE_VERSION,
    purpose: NORMAL_ENGINE_PROVIDER_CAPTURE_PURPOSE,
    ...structuredClone(binding),
    requests: [],
  });
  return {
    runId: parsed.runId,
    phase: parsed.phase,
    caseId: parsed.caseId,
    runtime: parsed.runtime,
    target: parsed.target,
    policy: parsed.policy,
    groundedEvidenceSemanticsVersion: parsed.groundedEvidenceSemanticsVersion,
  };
}

export function normalEngineQualificationProviderCaptureRelativePath(
  binding: Pick<NormalEngineProviderCaptureBinding, 'runId' | 'phase' | 'caseId'>,
): string {
  if (!/^nq_[a-f0-9]{32}$/u.test(binding.runId)
    || !['single', 'repair-introduction', 'repair-head', 'same-head-recheck'].includes(binding.phase)
    || !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(binding.caseId)) {
    throw new Error('normal engine qualification provider capture identity is invalid');
  }
  return `normal-engine-qualification-store/${binding.runId}/${binding.phase}/${binding.caseId}/provider-capture.record/provider-capture.json`;
}

const BIFROST_QUALIFICATION_HEADERS = NORMAL_ENGINE_PROVIDER_CAPTURE_HEADER_NAMES;

function hasBifrostRoutingHeaders(headers: Headers): boolean {
  return BIFROST_QUALIFICATION_HEADERS.some((header) => headers.has(header));
}

function parseNonnegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d{1,12}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function normalEngineQualificationProviderIdentityStatus(
  calls: readonly NormalEngineQualificationProviderCall[],
): 'unknown' | 'response_reported_unverified' {
  return calls.some((call) => call.responseReportedModel !== null)
    ? 'response_reported_unverified' : 'unknown';
}
