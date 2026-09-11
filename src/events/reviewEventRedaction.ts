import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { LiveStreamEvent, ReviewEventIdentity } from '../types/live';
import {
  REVIEW_EVENT_SCHEMA,
  isReviewEventValidationError,
  parseReviewYetiEventV1,
  reviewEventIdentitySchema,
  reviewEventTimestampSchema,
  type ReviewYetiEventV1,
} from './reviewYetiEvent';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIVE_EVENT_FIELDS = new Set(['jobId', 'timestamp', 'type', 'persona', 'data']);
const OMITTED_LEGACY_FIELDS = new Set([
  'repo',
  'prnumber',
  'personaid',
  'charter',
  'required',
  'paths',
  'decision',
  'requestedmodel',
  'resolvedmodel',
  'iserror',
  'stream',
]);
const FORBIDDEN_LEGACY_FIELDS = new Map<string, string>([
  ['authorization', 'credential-shaped field'],
  ['apikey', 'credential-shaped field'],
  ['accesstoken', 'credential-shaped field'],
  ['secret', 'credential-shaped field'],
  ['password', 'credential-shaped field'],
  ['privatekey', 'credential-shaped field'],
  ['credential', 'credential-shaped field'],
  ['cookie', 'credential-shaped field'],
  ['prompt', 'prompt'],
  ['promptsnippet', 'prompt'],
  ['diff', 'diff'],
  ['patch', 'diff'],
  ['source', 'source body'],
  ['sourcebody', 'source body'],
  ['filepath', 'repository-relative path'],
  ['path', 'repository-relative path'],
  ['token', 'raw token text'],
  ['rawtoken', 'raw token text'],
  ['rawmodeloutput', 'raw model output'],
  ['chunk', 'raw model output'],
  ['rationale', 'raw model output'],
  ['error', 'unbounded error'],
  ['errormessage', 'unbounded error'],
  ['exception', 'unbounded error'],
  ['stack', 'unbounded error'],
  ['stderr', 'unbounded error'],
  ['message', 'message without safe provenance'],
]);
const legacyFieldName = (field: string) => field.replace(/[^a-z0-9]/giu, '').toLowerCase();

const legacyProgressFields = new Set([
  'personaId',
  'provider',
  'model',
  'requestedModel',
  'resolvedModel',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'tokensUsed',
  'durationMs',
  'totalDurationMs',
  'latencyMs',
  'findingsCount',
  'totalFindings',
  'costUSD',
  'totalCostUSD',
  'status',
  'stage',
  'errorClass',
  'verdict',
  'quorumSatisfied',
  'distinctProviders',
  'totalPersonasExecuted',
  ...OMITTED_LEGACY_FIELDS,
]);

export type ReviewEventRejectionCode =
  | 'invalid_live_event'
  | 'invalid_identity'
  | 'unknown_field'
  | 'forbidden_field'
  | 'invalid_field'
  | 'message_too_long'
  | 'payload_too_large';

export class ReviewEventRejection extends Error {
  public readonly name = 'ReviewEventRejection';

  public get ok(): false { return false; }
  public get accepted(): false { return false; }
  public get error(): ReviewEventRejection { return this; }
  public get rejection(): ReviewEventRejection { return this; }

  constructor(
    public readonly code: ReviewEventRejectionCode,
    public readonly field?: string,
    message = `Review progress event rejected: ${code}${field ? ` (${field})` : ''}`,
  ) {
    super(message);
  }
}

export interface ReviewEventIdentityWire {
  repository_id: number;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  attempt_id: string;
  run_id: string;
  sequence: number;
  correlation_id: string;
  trace_id: string;
}

export type ReviewEventIdentityInput = (ReviewEventIdentity | ReviewEventIdentityWire) & {
  eventId?: string;
  event_id?: string;
};

function normalizeIdentity(identity: ReviewEventIdentityInput): Record<string, unknown> {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return {};
  const value = identity as unknown as Record<string, unknown>;
  return {
    repository_id: value.repositoryId ?? value.repository_id,
    pr_number: value.prNumber ?? value.pr_number,
    base_sha: value.baseSha ?? value.base_sha,
    head_sha: value.headSha ?? value.head_sha,
    attempt_id: value.attemptId ?? value.attempt_id,
    run_id: value.runId ?? value.run_id,
    sequence: value.sequence,
    correlation_id: value.correlationId ?? value.correlation_id,
    trace_id: value.traceId ?? value.trace_id,
  };
}

function newUlid(timestamp: string): string {
  const parsedMilliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(parsedMilliseconds) || parsedMilliseconds < 0) {
    throw new Error('invalid event timestamp');
  }
  const milliseconds = BigInt(parsedMilliseconds);
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Number(milliseconds), 0, 6);
  randomBytes(10).copy(bytes, 6);

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let result = '';
  for (let index = 0; index < 26; index++) {
    result = ULID_ALPHABET[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function copyIfPresent(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string = inputKey,
): void {
  if (hasOwn(input, inputKey) && input[inputKey] !== undefined) output[outputKey] = input[inputKey];
}

function copyNumber(
  output: Record<string, unknown>,
  input: Record<string, unknown>,
  inputKey: string,
  outputKey: string,
): void {
  if (hasOwn(input, inputKey) && input[inputKey] !== undefined) output[outputKey] = input[inputKey];
}

function buildProgressData(liveEvent: LiveStreamEvent): Record<string, unknown> | ReviewEventRejection {
  const source = liveEvent.data;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return new ReviewEventRejection('invalid_live_event', 'data');
  }
  const data = source as Record<string, unknown>;

  for (const field of Object.keys(data)) {
    const normalized = legacyFieldName(field);
    if (FORBIDDEN_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection('forbidden_field', field, `Review progress event contains a ${FORBIDDEN_LEGACY_FIELDS.get(normalized)}`);
    }
    if (!legacyProgressFields.has(field) && !OMITTED_LEGACY_FIELDS.has(normalized)) {
      return new ReviewEventRejection('unknown_field', field);
    }
  }

  const output: Record<string, unknown> = {};
  const persona = typeof liveEvent.persona === 'string' && liveEvent.persona.length > 0
    ? liveEvent.persona
    : data.personaId;
  if (persona !== undefined) output.persona = persona;
  copyIfPresent(output, data, 'stage');
  copyIfPresent(output, data, 'status');
  copyIfPresent(output, data, 'provider');
  const model = data.resolvedModel ?? data.model ?? data.requestedModel;
  if (model !== undefined) output.model = model;

  const tokensUsed = data.tokensUsed;
  if (tokensUsed !== undefined) {
    const tokenShape = z.object({ prompt: z.number(), completion: z.number(), total: z.number() }).strict().safeParse(tokensUsed);
    if (typeof tokensUsed !== 'object' || tokensUsed === null || Array.isArray(tokensUsed)) {
      if (typeof tokensUsed !== 'number') return new ReviewEventRejection('invalid_field', 'tokensUsed');
      output.total_tokens = tokensUsed;
    } else if (!tokenShape.success) {
      return new ReviewEventRejection('invalid_field', 'tokensUsed');
    } else {
      output.prompt_tokens = tokenShape.data.prompt;
      output.completion_tokens = tokenShape.data.completion;
      output.total_tokens = tokenShape.data.total;
    }
  }
  copyNumber(output, data, 'promptTokens', 'prompt_tokens');
  copyNumber(output, data, 'completionTokens', 'completion_tokens');
  copyNumber(output, data, 'totalTokens', 'total_tokens');
  copyNumber(output, data, 'durationMs', 'duration_ms');
  copyNumber(output, data, 'totalDurationMs', 'total_duration_ms');
  copyNumber(output, data, 'latencyMs', 'latency_ms');
  copyNumber(output, data, 'findingsCount', 'findings_count');
  copyNumber(output, data, 'totalFindings', 'total_findings');
  copyNumber(output, data, 'costUSD', 'cost_usd');
  copyNumber(output, data, 'totalCostUSD', 'total_cost_usd');
  copyIfPresent(output, data, 'errorClass', 'error_class');
  copyIfPresent(output, data, 'verdict');
  copyIfPresent(output, data, 'quorumSatisfied', 'quorum_satisfied');
  copyIfPresent(output, data, 'distinctProviders', 'distinct_providers');
  copyIfPresent(output, data, 'totalPersonasExecuted', 'total_personas_executed');

  return output;
}

const EVENT_KIND_BY_TYPE: Record<string, string> = {
  'persona:start': 'review.progress.persona_started',
  'persona:chunk': 'review.progress.persona_progress',
  'persona:complete': 'review.progress.persona_completed',
  'llm:prompt': 'review.progress.llm_prompt',
  'llm:token': 'review.progress.token_metrics',
  'llm:error': 'review.progress.llm_error',
  'omniroute:metric': 'review.progress.provider_metric',
  'openrouter:metric': 'review.progress.provider_metric',
  'ast:lookup': 'review.progress.analysis_lookup',
  'nit:suppression': 'review.progress.finding_suppression',
  'job:queued': 'review.progress.job_queued',
  'job:dispatched': 'review.progress.job_dispatched',
  'job:complete': 'review.progress.job_completed',
  agent_start: 'review.progress.persona_started',
  llm_chunk: 'review.progress.persona_progress',
  agent_done: 'review.progress.persona_completed',
  indexer_lookup: 'review.progress.analysis_lookup',
  quorum_verdict: 'review.progress.quorum_verdict',
};
const NEVER_FORWARD_EVENT_TYPES = new Set(['persona:chunk', 'llm:prompt', 'llm_chunk']);
const CANONICAL_MESSAGE_BY_EVENT_KIND: Record<string, string> = {
  'review.progress.persona_started': 'Persona review started',
  'review.progress.persona_completed': 'Persona review completed',
  'review.progress.token_metrics': 'Token metrics updated',
  'review.progress.llm_error': 'LLM request failed',
  'review.progress.provider_metric': 'Provider metrics updated',
  'review.progress.analysis_lookup': 'Analysis lookup completed',
  'review.progress.finding_suppression': 'Finding suppression evaluated',
  'review.progress.job_queued': 'Review queued',
  'review.progress.job_dispatched': 'Review dispatched',
  'review.progress.job_completed': 'Review completed',
  'review.progress.quorum_verdict': 'Quorum verdict recorded',
};

/**
 * Convert the legacy in-process event shape to the closed progress contract.
 * The returned envelope is the only value permitted to cross a future durable
 * event sink; the permissive legacy data map is never copied wholesale.
 */
export function sanitizeProgressEvent(
  liveEvent: LiveStreamEvent,
  identity: ReviewEventIdentityInput,
): ReviewYetiEventV1 | ReviewEventRejection {
  if (!liveEvent || typeof liveEvent !== 'object' || Array.isArray(liveEvent)) {
    return new ReviewEventRejection('invalid_live_event');
  }
  const eventRecord = liveEvent as unknown as Record<string, unknown>;
  const unknownEventField = Object.keys(eventRecord).find((field) => !LIVE_EVENT_FIELDS.has(field));
  if (unknownEventField) return new ReviewEventRejection('unknown_field', unknownEventField);

  const eventKind = EVENT_KIND_BY_TYPE[liveEvent.type];
  if (!eventKind) return new ReviewEventRejection('invalid_live_event', 'type');
  if (NEVER_FORWARD_EVENT_TYPES.has(liveEvent.type)) {
    return new ReviewEventRejection('forbidden_field', 'type', 'Review progress event type carries non-sanitizable content');
  }

  const wireIdentity = normalizeIdentity(identity);
  const identityResult = reviewEventIdentitySchema.safeParse(wireIdentity);
  if (!identityResult.success) return new ReviewEventRejection('invalid_identity');

  const data = buildProgressData(liveEvent);
  if (data instanceof ReviewEventRejection) return data;
  const canonicalMessage = CANONICAL_MESSAGE_BY_EVENT_KIND[eventKind];
  if (!canonicalMessage) return new ReviewEventRejection('invalid_live_event', 'type');
  data.message = canonicalMessage;

  if (!reviewEventTimestampSchema.safeParse(liveEvent.timestamp).success) {
    return new ReviewEventRejection('invalid_field', 'timestamp');
  }

  let eventId: string;
  try {
    eventId = (identity as ReviewEventIdentityInput).eventId
      ?? (identity as ReviewEventIdentityInput).event_id
      ?? newUlid(liveEvent.timestamp);
  } catch {
    return new ReviewEventRejection('invalid_field', 'timestamp');
  }

  const event = {
    schema: REVIEW_EVENT_SCHEMA,
    event_id: eventId,
    event_kind: eventKind,
    occurred_at: liveEvent.timestamp,
    ...identityResult.data,
    visibility: 'internal' as const,
    data,
  };

  try {
    return parseReviewYetiEventV1(event);
  } catch (error) {
    if (isReviewEventValidationError(error) && error.code === 'payload_too_large') {
      return new ReviewEventRejection('payload_too_large');
    }
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const field = issue?.path.length ? issue.path.join('.') : undefined;
      if (field === 'data.message') return new ReviewEventRejection('message_too_long', 'message');
      return new ReviewEventRejection('invalid_field', field);
    }
    return new ReviewEventRejection('invalid_live_event');
  }
}
