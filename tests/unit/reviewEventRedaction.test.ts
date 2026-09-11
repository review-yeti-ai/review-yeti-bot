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
        message: 'Persona review completed',
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

  it('maps numeric tokensUsed to total_tokens', () => {
    const result = sanitizeProgressEvent(liveEvent({
      tokensUsed: 130,
    }, 'llm:token'), identity);

    expect(result).toMatchObject({
      data: {
        total_tokens: 130,
      },
    });
    expect(result).not.toHaveProperty('data.prompt_tokens');
    expect(result).not.toHaveProperty('data.completion_tokens');
  });

  it('maps aggregate duration, finding, and cost fields to total fields', () => {
    const result = sanitizeProgressEvent(liveEvent({
      totalDurationMs: 2_400,
      totalFindings: 7,
      totalCostUSD: 0.42,
    }), identity);

    expect(result).toMatchObject({
      data: {
        total_duration_ms: 2_400,
        total_findings: 7,
        total_cost_usd: 0.42,
      },
    });
  });

  it('keeps aggregate and explicit per-stage metrics when both are present', () => {
    const result = sanitizeProgressEvent(liveEvent({
      durationMs: 850,
      totalDurationMs: 2_400,
      findingsCount: 2,
      totalFindings: 7,
      costUSD: 0.04,
      totalCostUSD: 0.42,
    }), identity);

    expect(result).toMatchObject({
      data: {
        duration_ms: 850,
        total_duration_ms: 2_400,
        findings_count: 2,
        total_findings: 7,
        cost_usd: 0.04,
        total_cost_usd: 0.42,
      },
    });
  });

  it.each([
    ['eventId', '01J8Z5M6V7Q8R9S0T1V2W3X4Y5'],
    ['event_id', '01J8Z5M6V7Q8R9S0T1V2W3X4Y6'],
  ] as const)('uses a caller-supplied %s', (field, suppliedEventId) => {
    const result = sanitizeProgressEvent(liveEvent({}), {
      ...identity,
      [field]: suppliedEventId,
    });

    expect(result).toMatchObject({ event_id: suppliedEventId });
  });

  it('returns a typed timestamp rejection when a supplied event ID bypasses ULID generation', () => {
    const event = liveEvent({});
    event.timestamp = 'not-a-timestamp';

    const rejection = rejectionOf(sanitizeProgressEvent(event, {
      ...identity,
      eventId: '01J8Z5M6V7Q8R9S0T1V2W3X4Y5',
    }));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('timestamp');
  });

  it('returns payload_too_large for a valid sanitized envelope over 16 KiB', () => {
    const distinctProviders = Array.from(
      { length: 32 },
      (_, index) => `provider-${index}-${'界'.repeat(240)}`,
    );

    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      distinctProviders,
    }, 'quorum_verdict'), {
      ...identity,
      eventId: '01J8Z5M6V7Q8R9S0T1V2W3X4Y5',
    }));

    expect(rejection.code).toBe('payload_too_large');
    expect(rejection.field).toBeUndefined();
  });

  it('uses typed error metadata with a canonical message', () => {
    const result = sanitizeProgressEvent(liveEvent({
      provider: 'openrouter',
      errorClass: 'provider_timeout',
    }, 'llm:error'), identity);

    expect(result).toMatchObject({
      event_kind: 'review.progress.llm_error',
      data: {
        provider: 'openrouter',
        error_class: 'provider_timeout',
        message: 'LLM request failed',
      },
    });
  });

  it('rejects unknown legacy data instead of silently forwarding it', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ unknownField: 'not allowed' }), identity));
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

  it.each([
    ['customer data', 'Customer ACME account 0042 reported private tenant data'],
    ['source code', 'export const customerSecret = process.env.CUSTOMER_SECRET;'],
    ['diff', '@@ -1 +1 @@\n-private customer value\n+replacement'],
    ['prompt', 'System prompt: review the private repository source verbatim'],
    ['raw output', 'Model output: hidden chain and unredacted finding body'],
    ['error', 'Error: database password leaked\n    at private/customer.ts:42:7'],
  ])('rejects arbitrary legacy message content with %s provenance', (_label, message) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ message }), identity));
    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe('message');
    expect(JSON.stringify(rejection)).not.toContain(message);
  });

  it('rejects an oversized arbitrary legacy message by provenance before content', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ message: 'x'.repeat(2_001) }), identity));
    expect(rejection.code).toBe('forbidden_field');
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
