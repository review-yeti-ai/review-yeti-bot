import { z } from 'zod';

export const REVIEW_EVENT_SCHEMA = 'review-yeti-event.v1' as const;
export const REVIEW_EVENT_SCHEMA_VERSION = 'v1' as const;
export const REVIEW_EVENT_MAX_BYTES = 16 * 1024;
export const REVIEW_PROGRESS_MESSAGE_MAX_CHARS = 2_000;
export const REVIEW_PROGRESS_MESSAGE_FORMAT = 'review-yeti-progress-message-v1' as const;

const EVENT_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/iu;
const EVENT_KIND_PATTERN = /^review\.(?:lifecycle|progress)\.(?!v\d(?:\.|$))[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SAFE_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f\s]+$/u;
const SAFE_MESSAGE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const boundedIdentifier = (max = 256) => z.string().min(1).max(max).regex(SAFE_IDENTIFIER_PATTERN);
const sha = z.string().regex(SHA_PATTERN);
const digest = z.string().regex(/^[a-f0-9]{64}$/iu);
const positiveInteger = z.number().int().positive().safe();
const nonnegativeInteger = z.number().int().nonnegative().safe();
const nonnegativeNumber = z.number().nonnegative().finite().safe();
const timestamp = z.string().datetime({ offset: true });

/** Executable definition of the schema format; length is Unicode code points, not UTF-16 code units. */
export function isReviewProgressMessageV1(value: string): boolean {
  return Array.from(value).length <= REVIEW_PROGRESS_MESSAGE_MAX_CHARS
    && !SAFE_MESSAGE_CONTROL_PATTERN.test(value);
}

const progressMessage = z.string().refine(
  isReviewProgressMessageV1,
  `message must contain at most ${REVIEW_PROGRESS_MESSAGE_MAX_CHARS} Unicode code points and no forbidden controls`,
);

export const EVENT_ENVELOPE_FIELD_INVENTORY = [
  'schema',
  'event_id',
  'event_kind',
  'occurred_at',
  'repository_id',
  'pr_number',
  'base_sha',
  'head_sha',
  'attempt_id',
  'run_id',
  'sequence',
  'correlation_id',
  'trace_id',
  'visibility',
  'data',
] as const;

export const LIFECYCLE_DATA_FIELD_INVENTORY = [
  'stage',
  'terminal_class',
  'result_digest',
  'policy_digest',
  'duration_ms',
  'retry_class',
  'evidence_pointers',
  'timing',
] as const;

export const PROGRESS_DATA_FIELD_INVENTORY = [
  'persona',
  'stage',
  'status',
  'provider',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'duration_ms',
  'latency_ms',
  'findings_count',
  'cost_usd',
  'message',
  'error_class',
  'verdict',
  'quorum_satisfied',
  'distinct_providers',
  'total_personas_executed',
  'total_findings',
  'total_duration_ms',
  'total_cost_usd',
] as const;

const lifecycleTimingSchema = z.object({
  queued_at: timestamp.optional(),
  started_at: timestamp.optional(),
  completed_at: timestamp.optional(),
  duration_ms: nonnegativeInteger.optional(),
}).strict();

export const lifecycleDataSchema = z.object({
  stage: boundedIdentifier(128).optional(),
  terminal_class: boundedIdentifier(128).optional(),
  result_digest: digest.optional(),
  policy_digest: digest.optional(),
  duration_ms: nonnegativeInteger.optional(),
  retry_class: boundedIdentifier(128).optional(),
  evidence_pointers: z.array(boundedIdentifier(512)).max(32).optional(),
  timing: lifecycleTimingSchema.optional(),
}).strict();

const progressStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const progressDataSchema = z.object({
  persona: boundedIdentifier(128).optional(),
  stage: boundedIdentifier(128).optional(),
  status: progressStatus.optional(),
  provider: boundedIdentifier(256).optional(),
  model: boundedIdentifier(256).optional(),
  prompt_tokens: nonnegativeInteger.optional(),
  completion_tokens: nonnegativeInteger.optional(),
  total_tokens: nonnegativeInteger.optional(),
  duration_ms: nonnegativeInteger.optional(),
  latency_ms: nonnegativeInteger.optional(),
  findings_count: nonnegativeInteger.optional(),
  cost_usd: nonnegativeNumber.optional(),
  message: progressMessage.optional(),
  error_class: boundedIdentifier(128).optional(),
  verdict: boundedIdentifier(128).optional(),
  quorum_satisfied: z.boolean().optional(),
  distinct_providers: z.array(boundedIdentifier(256)).max(32).optional(),
  total_personas_executed: nonnegativeInteger.optional(),
  total_findings: nonnegativeInteger.optional(),
  total_duration_ms: nonnegativeInteger.optional(),
  total_cost_usd: nonnegativeNumber.optional(),
}).strict();

const eventIdentityShape = {
  repository_id: positiveInteger,
  pr_number: positiveInteger,
  base_sha: sha,
  head_sha: sha,
  attempt_id: boundedIdentifier(),
  run_id: boundedIdentifier(),
  sequence: positiveInteger,
  correlation_id: boundedIdentifier(),
  trace_id: boundedIdentifier(),
};

export const reviewEventIdentitySchema = z.object(eventIdentityShape).strict();

const reviewEventEnvelopeBaseSchema = z.object({
  schema: z.literal(REVIEW_EVENT_SCHEMA),
  event_id: z.string().regex(EVENT_ID_PATTERN),
  event_kind: z.string().regex(EVENT_KIND_PATTERN),
  occurred_at: timestamp,
  ...eventIdentityShape,
  visibility: z.literal('internal'),
}).strict();

const lifecycleEventSchema = reviewEventEnvelopeBaseSchema.extend({
  event_kind: z.string().regex(/^review\.lifecycle\.(?!v\d(?:\.|$))[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  data: lifecycleDataSchema,
}).strict();

const progressEventSchema = reviewEventEnvelopeBaseSchema.extend({
  event_kind: z.string().regex(/^review\.progress\.(?!v\d(?:\.|$))[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
  data: progressDataSchema,
}).strict();

export const reviewYetiEventV1Schema = z.union([lifecycleEventSchema, progressEventSchema]);

export type ReviewYetiLifecycleEventV1 = z.infer<typeof lifecycleEventSchema>;
export type ReviewYetiProgressEventV1 = z.infer<typeof progressEventSchema>;
export type ReviewYetiEventV1 = z.infer<typeof reviewYetiEventV1Schema>;

export type ReviewEventValidationCode = 'payload_too_large' | 'not_serializable';

export class ReviewEventValidationError extends Error {
  public readonly name = 'ReviewEventValidationError';

  constructor(public readonly code: ReviewEventValidationCode, message: string) {
    super(message);
  }
}

function serializedBytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ReviewEventValidationError('not_serializable', 'Review event must be JSON-serializable');
  }
  if (serialized === undefined) {
    throw new ReviewEventValidationError('not_serializable', 'Review event must be a JSON value');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/** Parse before any persistence, publication, or other side effect. */
export function parseReviewYetiEventV1(value: unknown): ReviewYetiEventV1 {
  if (serializedBytes(value) > REVIEW_EVENT_MAX_BYTES) {
    throw new ReviewEventValidationError('payload_too_large', 'Review event exceeds the 16 KiB serialized payload limit');
  }

  const parsed = reviewYetiEventV1Schema.parse(value);
  if (serializedBytes(parsed) > REVIEW_EVENT_MAX_BYTES) {
    throw new ReviewEventValidationError('payload_too_large', 'Review event exceeds the 16 KiB serialized payload limit');
  }
  return parsed;
}

export function isReviewEventValidationError(error: unknown): error is ReviewEventValidationError {
  return error instanceof ReviewEventValidationError;
}
