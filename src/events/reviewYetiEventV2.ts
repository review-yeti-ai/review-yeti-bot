import { z } from 'zod';
import {
  lifecycleDataSchema,
  reviewEventIdentitySchema,
  reviewEventTimestampSchema,
  REVIEW_EVENT_MAX_BYTES,
  ReviewEventValidationError,
} from './reviewYetiEvent';

/**
 * The v2 envelope is deliberately a separate closed schema.  It reuses the
 * v1 identity and lifecycle-data validators, but its sequence is an aggregate
 * position rather than a reinterpretation of the v1 run-local position.
 */
export const REVIEW_YETI_EVENT_V2_SCHEMA = 'review-yeti-event.v2' as const;
export const REVIEW_YETI_EVENT_V2_SCHEMA_VERSION = 'v2' as const;
export const REVIEW_YETI_EVENT_V2_SEQUENCE_DOMAIN = 'pr_lifecycle_v2' as const;
export const REVIEW_YETI_EVENT_V2_MAX_BYTES = REVIEW_EVENT_MAX_BYTES;

// Keep the shorter names parallel with the existing v1 module's public
// constants while retaining the explicit v2-prefixed names at this boundary.
export const REVIEW_EVENT_V2_SCHEMA = REVIEW_YETI_EVENT_V2_SCHEMA;
export const REVIEW_EVENT_V2_SCHEMA_VERSION = REVIEW_YETI_EVENT_V2_SCHEMA_VERSION;
export const REVIEW_EVENT_V2_SEQUENCE_DOMAIN = REVIEW_YETI_EVENT_V2_SEQUENCE_DOMAIN;
export const REVIEW_EVENT_V2_MAX_BYTES = REVIEW_YETI_EVENT_V2_MAX_BYTES;

export const REVIEW_YETI_EVENT_V2_FIELD_INVENTORY = [
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
  'sequence_domain',
  'correlation_id',
  'trace_id',
  'visibility',
  'data',
] as const;
export const REVIEW_EVENT_V2_FIELD_INVENTORY = REVIEW_YETI_EVENT_V2_FIELD_INVENTORY;

const EVENT_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const LIFECYCLE_EVENT_KIND_PATTERN = /^review\.lifecycle\.(?!v\d(?:\.|$))[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

const v2EventSchema = z.object({
  schema: z.literal(REVIEW_YETI_EVENT_V2_SCHEMA),
  event_id: z.string().regex(EVENT_ID_PATTERN),
  event_kind: z.string().regex(LIFECYCLE_EVENT_KIND_PATTERN),
  occurred_at: reviewEventTimestampSchema,
  ...reviewEventIdentitySchema.shape,
  sequence_domain: z.literal(REVIEW_YETI_EVENT_V2_SEQUENCE_DOMAIN),
  visibility: z.literal('internal'),
  data: lifecycleDataSchema,
}).strict();

export const reviewYetiEventV2Schema = v2EventSchema;
export type ReviewYetiEventV2 = z.infer<typeof reviewYetiEventV2Schema>;
export type ReviewYetiLifecycleEventV2 = ReviewYetiEventV2;

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

/** Parse before any future v2 persistence, publication, or consumption side effect. */
export function parseReviewYetiEventV2(value: unknown): ReviewYetiEventV2 {
  if (serializedBytes(value) > REVIEW_YETI_EVENT_V2_MAX_BYTES) {
    throw new ReviewEventValidationError('payload_too_large', 'Review event exceeds the 16 KiB serialized payload limit');
  }

  const parsed = reviewYetiEventV2Schema.parse(value);
  if (serializedBytes(parsed) > REVIEW_YETI_EVENT_V2_MAX_BYTES) {
    throw new ReviewEventValidationError('payload_too_large', 'Review event exceeds the 16 KiB serialized payload limit');
  }
  return parsed;
}

export { ReviewEventValidationError };
