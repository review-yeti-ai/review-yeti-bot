import fs from 'node:fs';
import path from 'node:path';
import { Format } from 'typebox/format';
import { Check as checkJsonSchema, type XSchema } from 'typebox/schema';
import { describe, expect, it } from 'vitest';
import {
  EVENT_ENVELOPE_FIELD_INVENTORY,
  LIFECYCLE_DATA_FIELD_INVENTORY,
  PROGRESS_DATA_FIELD_INVENTORY,
  REVIEW_EVENT_MAX_BYTES,
  REVIEW_EVENT_SCHEMA,
  REVIEW_EVENT_SCHEMA_VERSION,
  REVIEW_PROGRESS_MESSAGE_FORMAT,
  isReviewProgressMessageV1,
  parseReviewYetiEventV1,
  reviewYetiEventV1Schema,
} from '../../src/events/reviewYetiEvent';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const occurredAt = '2026-09-11T12:00:00.000Z';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const schemaPath = path.resolve(__dirname, '../../schemas/review-yeti-event.v1.schema.json');
const jsonSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as XSchema & {
  $id: string;
  properties: Record<string, unknown>;
  additionalProperties: boolean;
  $defs: Record<string, { properties: Record<string, unknown>; additionalProperties: boolean }>;
};

Format.Set(REVIEW_PROGRESS_MESSAGE_FORMAT, isReviewProgressMessageV1);

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

  it('is the executable maintenance gate for JSON Schema and Zod semantic parity', () => {
    const withoutRunId = { ...validProgressEvent() } as Record<string, unknown>;
    delete withoutRunId.run_id;

    const fixtures: Array<{ name: string; accepted: boolean; value: unknown }> = [
      { name: 'valid lifecycle', accepted: true, value: validLifecycleEvent() },
      { name: 'valid progress', accepted: true, value: validProgressEvent() },
      { name: 'missing required run_id', accepted: false, value: withoutRunId },
      { name: 'malformed ULID', accepted: false, value: { ...validProgressEvent(), event_id: eventId.toLowerCase() } },
      { name: 'malformed event kind', accepted: false, value: { ...validProgressEvent(), event_kind: 'review.progress.v2.tokens' } },
      { name: 'malformed SHA', accepted: false, value: { ...validLifecycleEvent(), base_sha: 'main' } },
      { name: 'malformed digest', accepted: false, value: { ...validLifecycleEvent(), data: { ...validLifecycleEvent().data, result_digest: 'c'.repeat(63) } } },
      { name: 'identifier whitespace', accepted: false, value: { ...validProgressEvent(), run_id: 'run id' } },
      { name: 'zero repository id', accepted: false, value: { ...validLifecycleEvent(), repository_id: 0 } },
      { name: 'fractional PR number', accepted: false, value: { ...validLifecycleEvent(), pr_number: 1.5 } },
      { name: 'zero sequence', accepted: false, value: { ...validLifecycleEvent(), sequence: 0 } },
      { name: 'unsafe sequence', accepted: false, value: { ...validLifecycleEvent(), sequence: Number.MAX_SAFE_INTEGER + 1 } },
      { name: 'negative token count', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, prompt_tokens: -1 } } },
      { name: 'unsafe cost', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, cost_usd: Number.MAX_SAFE_INTEGER + 1 } } },
      { name: 'invalid occurred_at format', accepted: false, value: { ...validLifecycleEvent(), occurred_at: '2026-09-11' } },
      { name: 'invalid nested timestamp format', accepted: false, value: { ...validLifecycleEvent(), data: { ...validLifecycleEvent().data, timing: { queued_at: 'not-a-date' } } } },
      { name: 'unknown schema enum', accepted: false, value: { ...validProgressEvent(), schema: 'review-yeti-event.v2' } },
      { name: 'unknown visibility enum', accepted: false, value: { ...validProgressEvent(), visibility: 'public' } },
      { name: 'unknown progress status enum', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, status: 'running' } } },
      { name: 'top-level additional property', accepted: false, value: { ...validProgressEvent(), unexpected: true } },
      { name: 'data additional property', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, unexpected: true } } },
      { name: 'nested additional property', accepted: false, value: { ...validLifecycleEvent(), data: { ...validLifecycleEvent().data, timing: { queued_at: occurredAt, unexpected: true } } } },
      { name: '2,000 astral Unicode code points', accepted: true, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, message: '😀'.repeat(2_000) } } },
      { name: '2,001 astral Unicode code points', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, message: '😀'.repeat(2_001) } } },
      { name: '2,000 combining Unicode code points', accepted: true, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, message: `e${'\u0301'.repeat(1_999)}` } } },
      { name: '2,001 combining Unicode code points', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, message: `e${'\u0301'.repeat(2_000)}` } } },
      { name: 'forbidden message control', accepted: false, value: { ...validProgressEvent(), data: { ...validProgressEvent().data, message: 'status\u0000detail' } } },
    ];

    for (const fixture of fixtures) {
      expect(checkJsonSchema(jsonSchema, fixture.value), `${fixture.name} JSON Schema`).toBe(fixture.accepted);
      expect(reviewYetiEventV1Schema.safeParse(fixture.value).success, `${fixture.name} Zod`).toBe(fixture.accepted);
    }
  });

  it('keeps the shared field inventory and schema metadata aligned', () => {
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
