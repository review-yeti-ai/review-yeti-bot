import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_ENVELOPE_FIELD_INVENTORY,
  LIFECYCLE_DATA_FIELD_INVENTORY,
  PROGRESS_DATA_FIELD_INVENTORY,
  REVIEW_EVENT_MAX_BYTES,
  REVIEW_EVENT_SCHEMA,
  REVIEW_EVENT_SCHEMA_VERSION,
  parseReviewYetiEventV1,
  reviewYetiEventV1Schema,
} from '../../src/events/reviewYetiEvent';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const occurredAt = '2026-09-11T12:00:00.000Z';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function identityFields() {
  return {
    schema: REVIEW_EVENT_SCHEMA,
    event_id: eventId,
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
  } as const;
}

function validLifecycleEvent() {
  return {
    ...identityFields(),
    event_kind: 'review.lifecycle.terminal',
    data: {
      stage: 'terminal',
      terminal_class: 'clean',
      result_digest: 'c'.repeat(64),
      policy_digest: 'd'.repeat(64),
      duration_ms: 1234,
      retry_class: 'none',
      evidence_pointers: ['review://runs/review-run-42-1/terminal'],
    },
  };
}

function validProgressEvent() {
  return {
    ...identityFields(),
    event_kind: 'review.progress.persona_completed',
    data: {
      persona: 'security',
      stage: 'persona',
      status: 'completed',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
      duration_ms: 850,
      findings_count: 2,
      message: 'Security persona completed',
    },
  };
}

describe('review-yeti-event.v1 parser', () => {
  it('accepts a valid closed lifecycle envelope', () => {
    expect(parseReviewYetiEventV1(validLifecycleEvent())).toEqual(validLifecycleEvent());
  });

  it('accepts a valid closed progress envelope', () => {
    expect(parseReviewYetiEventV1(validProgressEvent())).toEqual(validProgressEvent());
  });

  it('rejects unknown top-level and data fields instead of stripping them', () => {
    expect(() => parseReviewYetiEventV1({ ...validProgressEvent(), unexpected: true })).toThrow();
    expect(() => parseReviewYetiEventV1({
      ...validProgressEvent(),
      data: { ...validProgressEvent().data, unexpected: true },
    })).toThrow();
  });

  it('rejects stale or malformed SHA shapes', () => {
    expect(() => parseReviewYetiEventV1({ ...validLifecycleEvent(), base_sha: 'main' })).toThrow();
    expect(() => parseReviewYetiEventV1({ ...validLifecycleEvent(), head_sha: 'f'.repeat(39) })).toThrow();
  });

  it('validates sequence shape without pretending to allocate monotonicity', () => {
    expect(() => parseReviewYetiEventV1({ ...validLifecycleEvent(), sequence: 0 })).toThrow();
    expect(() => parseReviewYetiEventV1({ ...validLifecycleEvent(), sequence: 1.5 })).toThrow();
  });

  it('rejects unknown event namespaces and unknown major schema versions', () => {
    expect(() => parseReviewYetiEventV1({ ...validProgressEvent(), event_kind: 'review.internal.secret' })).toThrow();
    expect(() => parseReviewYetiEventV1({ ...validProgressEvent(), schema: 'review-yeti-event.v2' })).toThrow();
    expect(() => parseReviewYetiEventV1({ ...validProgressEvent(), event_kind: 'review.progress.v2.tokens' })).toThrow();
  });

  it('rejects credential-shaped, prompt, diff, raw-token, and unbounded-error fields', () => {
    for (const forbiddenField of ['authorization', 'api_key', 'prompt', 'diff', 'token', 'raw_model_output', 'stack']) {
      expect(() => parseReviewYetiEventV1({
        ...validProgressEvent(),
        data: { ...validProgressEvent().data, [forbiddenField]: 'sensitive-value' },
      })).toThrow();
    }
  });

  it('rejects an envelope whose serialized representation exceeds 16 KiB', () => {
    const oversized = {
      ...validProgressEvent(),
      data: { ...validProgressEvent().data, message: 'x'.repeat(REVIEW_EVENT_MAX_BYTES) },
    };
    expect(() => parseReviewYetiEventV1(oversized)).toThrow(/payload|size|16.?KiB/i);
  });

  it('keeps the JSON Schema and Zod field inventory in parity', () => {
    const schemaPath = path.resolve(__dirname, '../../schemas/review-yeti-event.v1.schema.json');
    const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      $id: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
      $defs: Record<string, { properties: Record<string, unknown>; additionalProperties: boolean }>;
    };

    expect(jsonSchema.$id).toContain('review-yeti-event.v1.schema.json');
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(Object.keys(jsonSchema.properties).sort()).toEqual([...EVENT_ENVELOPE_FIELD_INVENTORY].sort());
    expect(Object.keys((reviewYetiEventV1Schema.options[0] as any).shape).sort()).toEqual([...EVENT_ENVELOPE_FIELD_INVENTORY].sort());
    expect(Object.keys(jsonSchema.$defs.lifecycleData.properties).sort()).toEqual([...LIFECYCLE_DATA_FIELD_INVENTORY].sort());
    expect(Object.keys(jsonSchema.$defs.progressData.properties).sort()).toEqual([...PROGRESS_DATA_FIELD_INVENTORY].sort());
    expect(jsonSchema.$defs.lifecycleData.additionalProperties).toBe(false);
    expect(jsonSchema.$defs.progressData.additionalProperties).toBe(false);
    expect(REVIEW_EVENT_SCHEMA_VERSION).toBe('v1');
  });

  it('declares the schema in the npm release file allowlist', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { files: string[] };
    expect(packageJson.files).toContain('schemas/');
  });
});
