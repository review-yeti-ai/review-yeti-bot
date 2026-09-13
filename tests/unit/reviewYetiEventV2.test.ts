import fs from 'node:fs';
import path from 'node:path';
import { Check as checkJsonSchema, type XSchema } from 'typebox/schema';
import { describe, expect, it } from 'vitest';
import {
  REVIEW_YETI_EVENT_V2_FIELD_INVENTORY,
  REVIEW_YETI_EVENT_V2_SEQUENCE_DOMAIN,
  REVIEW_YETI_EVENT_V2_SCHEMA,
  parseReviewYetiEventV2,
  reviewYetiEventV2Schema,
} from '../../src/events/reviewYetiEventV2';
import { parseReviewYetiEventV1, reviewYetiEventV1Schema } from '../../src/events/reviewYetiEvent';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const occurredAt = '2026-09-11T12:00:00.000Z';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const schemaPath = path.resolve(__dirname, '../../schemas/review-yeti-event.v2.schema.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as XSchema & {
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

function validEvent() {
  return {
    schema: 'review-yeti-event.v2',
    event_id: eventId,
    event_kind: 'review.lifecycle.terminal',
    occurred_at: occurredAt,
    repository_id: 123,
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
    attempt_id: 'review-attempt-42-1',
    run_id: 'review-run-42-1',
    sequence: 17,
    sequence_domain: 'pr_lifecycle_v2',
    correlation_id: 'validation-42-1',
    trace_id: '9f000000000000000000000000000000',
    visibility: 'internal',
    data: {
      stage: 'terminal',
      terminal_class: 'clean',
      result_digest: 'c'.repeat(64),
      evidence_pointers: ['review://runs/review-run-42-1/terminal'],
    },
  };
}

describe('review-yeti-event.v2 parser', () => {
  it('accepts the closed lifecycle envelope and matches its language-neutral field inventory', () => {
    const expectedFields = [
      'schema', 'event_id', 'event_kind', 'occurred_at', 'repository_id', 'pr_number',
      'base_sha', 'head_sha', 'attempt_id', 'run_id', 'sequence', 'sequence_domain',
      'correlation_id', 'trace_id', 'visibility', 'data',
    ];
    expect(parseReviewYetiEventV2(validEvent())).toEqual(validEvent());
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(Object.keys(jsonSchema.properties).sort()).toEqual([...expectedFields].sort());
    expect(jsonSchema.required).toEqual(expectedFields);
    expect([...REVIEW_YETI_EVENT_V2_FIELD_INVENTORY]).toEqual(expectedFields);
    expect(checkJsonSchema(jsonSchema, validEvent())).toBe(true);
    expect(reviewYetiEventV2Schema.safeParse(validEvent()).success).toBe(true);
    expect(REVIEW_YETI_EVENT_V2_SCHEMA).toBe('review-yeti-event.v2');
    expect(REVIEW_YETI_EVENT_V2_SEQUENCE_DOMAIN).toBe('pr_lifecycle_v2');
  });

  it('rejects progress, versioned, wrong-domain, unknown-field, and secret-shaped inputs', () => {
    const base = validEvent();
    const invalidValues = [
      { ...base, event_kind: 'review.progress.persona_completed' },
      { ...base, event_kind: 'review.lifecycle.v2.terminal' },
      { ...base, sequence_domain: 'legacy_run_v1' },
      { ...base, sequenceDomain: 'pr_lifecycle_v2' },
      { ...base, unexpected: true },
      { ...base, data: { ...base.data, prompt: 'do not persist this' } },
      { ...base, data: { ...base.data, raw_model_output: 'do not persist this' } },
      { ...base, data: { ...base.data, authorization: 'do not persist this' } },
    ];

    for (const value of invalidValues) {
      expect(() => parseReviewYetiEventV2(value)).toThrow();
      expect(reviewYetiEventV2Schema.safeParse(value).success).toBe(false);
      expect(checkJsonSchema(jsonSchema, value)).toBe(false);
    }
  });

  it('rejects unsafe, negative, fractional, and non-finite aggregate coordinates', () => {
    const base = validEvent();
    const invalidValues = [
      { ...base, repository_id: 0 },
      { ...base, pr_number: -1 },
      { ...base, sequence: 1.5 },
      { ...base, repository_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, pr_number: Number.POSITIVE_INFINITY },
      { ...base, sequence: Number.NaN },
    ];

    for (const value of invalidValues) {
      expect(() => parseReviewYetiEventV2(value)).toThrow();
      expect(checkJsonSchema(jsonSchema, value)).toBe(false);
    }
    expect(parseReviewYetiEventV2({
      ...base,
      repository_id: Number.MAX_SAFE_INTEGER,
      pr_number: Number.MAX_SAFE_INTEGER,
      sequence: Number.MAX_SAFE_INTEGER,
    })).toMatchObject({
      repository_id: Number.MAX_SAFE_INTEGER,
      pr_number: Number.MAX_SAFE_INTEGER,
      sequence: Number.MAX_SAFE_INTEGER,
    });
  });

  it('preserves v1 progress acceptance while refusing to treat it as v2 lifecycle data', () => {
    const v1Progress = {
      schema: 'review-yeti-event.v1',
      event_id: eventId,
      event_kind: 'review.progress.persona_completed',
      occurred_at: occurredAt,
      repository_id: 123,
      pr_number: 42,
      base_sha: baseSha,
      head_sha: headSha,
      attempt_id: 'review-attempt-42-1',
      run_id: 'review-run-42-1',
      sequence: 17,
      correlation_id: 'validation-42-1',
      trace_id: '9f000000000000000000000000000000',
      visibility: 'internal',
      data: { persona: 'security', status: 'completed', message: 'done' },
    };

    expect(parseReviewYetiEventV1(v1Progress)).toEqual(v1Progress);
    expect(reviewYetiEventV1Schema.safeParse(v1Progress).success).toBe(true);
    expect(() => parseReviewYetiEventV2(v1Progress)).toThrow();
    expect(checkJsonSchema(jsonSchema, v1Progress)).toBe(false);
  });

  it('rejects oversize and non-JSON-serializable envelopes before parsing', () => {
    const oversized = {
      ...validEvent(),
      data: { evidence_pointers: Array.from({ length: 32 }, () => 'x'.repeat(512)) },
    };
    expect(() => parseReviewYetiEventV2(oversized)).toThrow(/payload|size|16.?KiB/i);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseReviewYetiEventV2({ ...validEvent(), data: circular })).toThrow(/JSON-serializable/i);
    expect(() => parseReviewYetiEventV2({ ...validEvent(), sequence: BigInt(1) })).toThrow(/JSON-serializable/i);
    expect(() => parseReviewYetiEventV2(undefined)).toThrow(/JSON value|serializable/i);
  });
});
