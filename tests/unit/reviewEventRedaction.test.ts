import { describe, expect, it } from 'vitest';
import {
  ReviewEventRejection,
  sanitizeProgressEvent,
} from '../../src/events/reviewEventRedaction';
import type { ReviewEventIdentity } from '../../src/types/live';

const identity: ReviewEventIdentity = {
  repositoryId: 123,
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  attemptId: 'review-attempt-42-1',
  runId: 'review-run-42-1',
  sequence: 3,
  correlationId: 'validation-42-1',
  traceId: '9f000000000000000000000000000000',
};

function liveEvent(data: Record<string, unknown>, type: string = 'persona:complete') {
  return {
    jobId: 'legacy-job-42',
    timestamp: '2026-09-11T12:00:00.000Z',
    type,
    persona: 'security',
    data,
  } as any;
}

function rejectionOf(result: unknown): ReviewEventRejection {
  expect(result).toBeInstanceOf(ReviewEventRejection);
  return result as ReviewEventRejection;
}

describe('progress event redaction boundary', () => {
  it('maps an allowlisted legacy event to a bound progress envelope', () => {
    const result = sanitizeProgressEvent(liveEvent({
      personaId: 'security',
      provider: 'openrouter',
      model: 'openai/gpt-5',
      durationMs: 850,
      findingsCount: 2,
      message: 'Security persona completed',
    }), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(result).toMatchObject({
      schema: 'review-yeti-event.v1',
      event_kind: 'review.progress.persona_completed',
      repository_id: 123,
      pr_number: 42,
      base_sha: identity.baseSha,
      head_sha: identity.headSha,
      attempt_id: identity.attemptId,
      run_id: identity.runId,
      sequence: identity.sequence,
      correlation_id: identity.correlationId,
      trace_id: identity.traceId,
      visibility: 'internal',
      data: {
        persona: 'security',
        provider: 'openrouter',
        model: 'openai/gpt-5',
        duration_ms: 850,
        findings_count: 2,
        message: 'Security persona completed',
      },
    });
    expect(result).not.toHaveProperty('jobId');
    expect(result).not.toHaveProperty('data.personaId');
  });

  it('maps bounded token metrics but never raw token text', () => {
    const result = sanitizeProgressEvent(liveEvent({
      provider: 'openrouter',
      model: 'openai/gpt-5',
      tokensUsed: { prompt: 100, completion: 30, total: 130 },
      latencyMs: 850,
    }, 'llm:token'), identity);

    expect(result).toMatchObject({
      event_kind: 'review.progress.token_metrics',
      data: {
        provider: 'openrouter',
        model: 'openai/gpt-5',
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        latency_ms: 850,
      },
    });
    expect(result).not.toHaveProperty('data.token');
  });

  it('rejects unknown legacy data instead of silently forwarding it', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ message: 'safe', unknownField: 'not allowed' }), identity));
    expect(rejection.code).toBe('unknown_field');
    expect(rejection.field).toBe('unknownField');
  });

  it.each([
    ['authorization', 'credential-shaped key'],
    ['apiKey', 'credential-shaped key'],
    ['promptSnippet', 'prompt'],
    ['diff', 'diff'],
    ['token', 'raw token'],
    ['chunk', 'raw model output'],
    ['error', 'unbounded error'],
    ['stack', 'unbounded error'],
  ])('rejects %s (%s) at the sanitizer boundary', (field) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ [field]: 'must not cross' }), identity));
    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(field);
  });

  it('rejects a progress message over 2,000 characters', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ message: 'x'.repeat(2_001) }), identity));
    expect(rejection.code).toBe('message_too_long');
    expect(rejection.field).toBe('message');
  });

  it('rejects invalid identity before producing an envelope', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ message: 'safe' }), {
      ...identity,
      headSha: 'stale',
    }));
    expect(rejection.code).toBe('invalid_identity');
  });

  it('rejects legacy prompt events even when their data includes otherwise safe metrics', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      provider: 'openrouter',
      model: 'openai/gpt-5',
      promptSnippet: 'do not publish this',
    }, 'llm:prompt'), identity));
    expect(rejection.code).toBe('forbidden_field');
  });

  it('rejects prompt and raw chunk event types even when their data map is empty', () => {
    for (const type of ['llm:prompt', 'persona:chunk', 'llm_chunk']) {
      const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}, type), identity));
      expect(rejection.code).toBe('forbidden_field');
      expect(rejection.field).toBe('type');
    }
  });
});
