import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  ReviewEventRejection,
  isSanitizedProgressEvent,
  sanitizeProgressEvent,
} from '../../src/events/reviewEventRedaction';
import {
  ReviewEventValidationError,
  parseReviewYetiEventV1,
} from '../../src/events/reviewYetiEvent';
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

type CredentialLeakFixture = {
  event: ReturnType<typeof liveEvent>;
  identity: ReviewEventIdentity;
};

const credentialStringLocations: Array<{
  label: string;
  field: string;
  inject: (value: string) => CredentialLeakFixture;
}> = [
  {
    label: 'persona',
    field: 'persona',
    inject: (value) => {
      const event = liveEvent({});
      event.persona = value;
      return { event, identity };
    },
  },
  {
    label: 'personaId',
    field: 'persona',
    inject: (value) => {
      const event = liveEvent({ personaId: value });
      event.persona = '';
      return { event, identity };
    },
  },
  {
    label: 'stage',
    field: 'stage',
    inject: (value) => ({ event: liveEvent({ stage: value }), identity }),
  },
  {
    label: 'provider',
    field: 'provider',
    inject: (value) => ({ event: liveEvent({ provider: value }), identity }),
  },
  {
    label: 'model',
    field: 'model',
    inject: (value) => ({ event: liveEvent({ model: value }), identity }),
  },
  {
    label: 'requestedModel',
    field: 'model',
    inject: (value) => ({ event: liveEvent({ requestedModel: value }), identity }),
  },
  {
    label: 'resolvedModel',
    field: 'model',
    inject: (value) => ({ event: liveEvent({ resolvedModel: value }), identity }),
  },
  {
    label: 'errorClass',
    field: 'error_class',
    inject: (value) => ({ event: liveEvent({ errorClass: value }), identity }),
  },
  {
    label: 'verdict',
    field: 'verdict',
    inject: (value) => ({ event: liveEvent({ verdict: value }), identity }),
  },
  {
    label: 'distinctProviders',
    field: 'distinct_providers',
    inject: (value) => ({ event: liveEvent({ distinctProviders: [value] }), identity }),
  },
  {
    label: 'attemptId',
    field: 'attempt_id',
    inject: (value) => ({ event: liveEvent({}), identity: { ...identity, attemptId: value } }),
  },
  {
    label: 'runId',
    field: 'run_id',
    inject: (value) => ({ event: liveEvent({}), identity: { ...identity, runId: value } }),
  },
  {
    label: 'correlationId',
    field: 'correlation_id',
    inject: (value) => ({ event: liveEvent({}), identity: { ...identity, correlationId: value } }),
  },
  {
    label: 'traceId',
    field: 'trace_id',
    inject: (value) => ({ event: liveEvent({}), identity: { ...identity, traceId: value } }),
  },
];

const credentialLeakFamilies: Array<{ label: string; values: string[] }> = [
  {
    label: 'single-slash URL authority',
    values: ['https:/review:matrix-synthetic-secret@private.test'],
  },
  {
    label: 'backslash or mixed URL authority',
    values: [
      String.raw`https:\review:matrix-synthetic-secret@private.test`,
      String.raw`https:\\review:matrix-synthetic-secret@private.test`,
      String.raw`https:/\review:matrix-synthetic-secret@private.test`,
      String.raw`https:\/review:matrix-synthetic-secret@private.test`,
    ],
  },
  {
    label: 'quoted api_key assignment',
    values: ['{"api_key":"matrix-synthetic-secret"}'],
  },
  {
    label: 'quoted accessToken assignment',
    values: ['{"accessToken":"matrix-synthetic-secret"}'],
  },
];

const credentialLeakMatrix = credentialStringLocations.flatMap((location) => (
  credentialLeakFamilies.map((family) => [
    `${location.label} / ${family.label}`,
    location,
    family.values,
  ] as const)
));

const reviewerCredentialUrlLeaks = [
  'https://u:s,e@host.test',
  'https://u:s;e@host.test',
  'https://u:s"e@host.test',
  "https://u:s'e@host.test",
  'https://u:s`e@host.test',
  'https://u:s<e@host.test',
  'https://u:s>e@host.test',
  'https://u:s[e]@host.test',
  'https://u:s{e}@host.test',
  'https://u:s@[::1]',
  'https:u:s@host.test',
  'HTTP:u:s@host.test',
  'http:u:s@host.test',
  'ftp:u:s@host.test',
  'ws:u:s@host.test',
  'wss:u:s@host.test',
  'https:u@host.test',
  'https::s@host.test',
  'ftp::s@host.test',
] as const;

const reviewerBenignUrlValues = [
  'https://host.test/path,//u@host.test',
  'https://host.test/path;//u@host.test',
  'https://host.test/path"//u@host.test',
  "https://host.test/path'//u@host.test",
  'https://host.test/path`//u@host.test',
  'https://host.test/path<//u@host.test',
  'https://host.test/path>//u@host.test',
  'https://host.test/path[//u@host.test]',
  'https://host.test/path{//u@host.test}',
  'https://host.test/path},//u@host.test',
  'nats:/u@host.test',
  'nats:////u@host.test',
  'tls:/u@host.test',
  'tls:////u@host.test',
  String.raw`nats:\\u@host.test`,
  String.raw`nats:/\/u@host.test`,
  String.raw`tls:\\u@host.test`,
  String.raw`tls:/\/u@host.test`,
  'nats:/u@host.test,https://safe.test/path/user@example.com',
  'https://safe.test/path/user@example.com,nats:/u@host.test',
] as const;

const maskedCredentialUrlValues = [
  'nats:/u@host.test,https://u:p@host.test',
  'note:https://u:p@host.test',
] as const;

const maskedCredentialUrlControls = [
  'nats:/u@host.test,https://safe.test/path/user@example.com',
  'note:https://safe.test/path/user@example.com',
] as const;

const wrappedOrAdjacentCredentialUrlValues = [
  '<https://u:p@host.test>',
  '[https://u:p@[::1]]',
  'https://u:p@host.test:4222,https://safe.test',
] as const;

const safeFirstWrappedListCredentialUrlValues = [
  '["https://safe.test/","https://u:p@host.test"]',
  '<https://safe.test/>;<https://u:p@host.test>',
  '{"primary":"https://safe.test/","fallback":"https://u:p@host.test"}',
  '[<https://safe.test/>];<https://u:p@host.test>',
] as const;

const closingWrapperAdjacentCredentialUrlValues = [
  '(https://safe.test/)https://u:p@host.test',
  '[https://safe.test/]https://u:p@host.test',
  '{nats://safe.test/}nats://u:p@host.test',
  '(https://safe.test/)//u:p@host.test',
  '[https://safe.test/]//u:p@host.test',
  '(https://safe.test/),//u:p@host.test',
  '[https://safe.test/];//u:p@host.test',
  '"https://safe.test/"https://u:p@host.test',
  '"https://safe.test/"//u:p@host.test',
  "'https://safe.test/'https://u:p@host.test",
  "'https://safe.test/'//u:p@host.test",
  '`https://safe.test/`https://u:p@host.test',
  '`https://safe.test/`//u:p@host.test',
  '(https://safe.test/)=https://u:p@host.test',
  '(https://safe.test/)=//u:p@host.test',
  '[https://safe.test/]:https://u:p@host.test',
  '[https://safe.test/]://u:p@host.test',
  '(https://safe.test/)=(https://u:p@host.test)',
  '(https://safe.test/)=(//u:p@host.test)',
  '[https://safe.test/]:[https://u:p@host.test]',
  '[https://safe.test/]:[//u:p@host.test]',
  '(https://safe.test/)=((//u:p@host.test))',
  '[https://safe.test/]:[[//u:p@host.test]]',
  '(https://safe.test/)=([{<https:/u:p@host.test>}])',
  `(https://safe.test/)=${'('.repeat(65)}//u:p@host.test${')'.repeat(65)}`,
] as const;

const wrappedSchemeRelativeCredentialUrlValues = [
  '["https://safe.test/","//u:p@host.test"]',
  '<https://safe.test/>;<//u:p@host.test>',
] as const;

const canonicalCustomAuthorityQueryControls = [
  'nats://host.test/path?next=https://u:p@host.test',
  'tls://[::1]/path?next=//u@host.test',
  'https://host.test/path?next=(https://u:p@host.test)',
  'nats://host.test/path?next=[https://u:p@host.test]',
  'https://host.test/path?next=(safe)//u:p@host.test',
  'nats://host.test/path?next=[safe]//u:p@host.test',
  'https://host.test/path?next="safe"//u:p@host.test',
  'nats://host.test/path?next=`safe`//u:p@host.test',
  'https://host.test/path?next=//u:p@host.test',
  'nats://host.test/path?next:https://u:p@host.test',
  'https://host.test/path?next=(//u:p@host.test)',
  'nats://host.test/path?next:[https://u:p@host.test]',
  'https://host.test/path?next=((//u:p@host.test))',
  'nats://host.test/path?next:[[https:/u:p@host.test]]',
] as const;

const canonicalCustomAuthorityCredentialValues = [
  'nats://u:p@host.test',
  'tls://u:p@host.test',
] as const;

const decoyMaskedCredentialUrlValues = [
  'note:https://[invalid],https://u:p@host.test',
  'note:https://host.test:bad,https://u:p@host.test',
  'note:https:,https://u:p@host.test',
  'note:https:=https://u:p@host.test',
  'note:https::https://u:p@host.test',
  'note:https:=(//u:p@host.test)',
  'note:https:://u:p@host.test',
  '//[invalid],https://u:p@host.test',
  'note:nats://u:p@host.test',
  'note:label:tls://u:p@host.test',
] as const;

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

  it('rejects an incomplete object tokensUsed shape', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      tokensUsed: { prompt: 100 },
    }, 'llm:token'), identity));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('tokensUsed');
  });

  it('rejects a string tokensUsed value', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      tokensUsed: '130',
    }, 'llm:token'), identity));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('tokensUsed');
  });

  it.each([
    ['null', null],
    ['array', []],
  ])('rejects a %s tokensUsed value', (_label, tokensUsed) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      tokensUsed,
    }, 'llm:token'), identity));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('tokensUsed');
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

  it('maps remaining typed progress fields and prefers the resolved model', () => {
    const result = sanitizeProgressEvent(liveEvent({
      stage: 'quorum',
      status: 'completed',
      provider: 'openrouter',
      requestedModel: 'requested/model',
      model: 'configured/model',
      resolvedModel: 'resolved/model',
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      latencyMs: 44,
      errorClass: 'none',
      verdict: 'ship',
      quorumSatisfied: true,
      distinctProviders: ['provider-a', 'provider-b'],
      totalPersonasExecuted: 2,
    }, 'quorum_verdict'), identity);

    expect(result).toMatchObject({
      data: {
        stage: 'quorum',
        status: 'completed',
        provider: 'openrouter',
        model: 'resolved/model',
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        latency_ms: 44,
        error_class: 'none',
        verdict: 'ship',
        quorum_satisfied: true,
        distinct_providers: ['provider-a', 'provider-b'],
        total_personas_executed: 2,
      },
    });
  });

  it('uses requestedModel when no configured or resolved model exists', () => {
    const result = sanitizeProgressEvent(liveEvent({
      requestedModel: 'requested/model',
    }), identity);

    expect(result).toMatchObject({ data: { model: 'requested/model' } });
  });

  it('uses personaId when the top-level legacy persona is empty', () => {
    const event = liveEvent({ personaId: 'architecture' });
    event.persona = '';

    const result = sanitizeProgressEvent(event, identity);
    expect(result).toMatchObject({ data: { persona: 'architecture' } });
  });

  it('accepts wire-format identity fields without dropping their bindings', () => {
    const result = sanitizeProgressEvent(liveEvent({}), {
      repository_id: 321,
      pr_number: 24,
      base_sha: 'c'.repeat(40),
      head_sha: 'd'.repeat(40),
      attempt_id: 'wire-attempt',
      run_id: 'wire-run',
      sequence: 9,
      correlation_id: 'wire-correlation',
      trace_id: 'wire-trace',
      event_id: '01J8Z5M6V7Q8R9S0T1V2W3X4Y7',
    });

    expect(result).toMatchObject({
      event_id: '01J8Z5M6V7Q8R9S0T1V2W3X4Y7',
      repository_id: 321,
      pr_number: 24,
      base_sha: 'c'.repeat(40),
      head_sha: 'd'.repeat(40),
      attempt_id: 'wire-attempt',
      run_id: 'wire-run',
      sequence: 9,
      correlation_id: 'wire-correlation',
      trace_id: 'wire-trace',
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

  it('generates a strict ULID when the caller supplies no event ID', () => {
    const result = sanitizeProgressEvent(liveEvent({}), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(result).toMatchObject({ schema: 'review-yeti-event.v1' });
    expect('event_id' in result ? result.event_id : '').toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  });

  it('rejects an invalid caller event ID with its exact envelope field', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}), {
      ...identity,
      eventId: 'not-a-ulid',
    }));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('event_id');
  });

  it('returns a typed timestamp rejection for a pre-epoch ULID timestamp', () => {
    const event = liveEvent({});
    event.timestamp = '0000-01-01T00:00:00.000Z';

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));
    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('timestamp');
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

  it('returns the exact envelope path for a negative legacy duration', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({
      durationMs: -1,
    }), identity));

    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('data.duration_ms');
  });

  it.each([
    ['invalid', 'persona with spaces'],
    ['oversized', 'p'.repeat(129)],
  ])('returns the exact envelope path for an %s legacy persona', (_label, persona) => {
    const event = liveEvent({});
    event.persona = persona;

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));
    expect(rejection.code).toBe('invalid_field');
    expect(rejection.field).toBe('data.persona');
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

  it('omits allowlisted legacy-only metadata rather than forwarding it', () => {
    const result = sanitizeProgressEvent(liveEvent({
      repo: 'owner/private-repository',
      prnumber: 42,
      charter: 'private review instructions',
      required: true,
      paths: ['private/source.ts'],
      decision: 'legacy-only',
      isError: false,
      stream: 'stdout',
    }), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(result).toHaveProperty('event_kind', 'review.progress.persona_completed');
    for (const field of ['repo', 'prnumber', 'charter', 'required', 'paths', 'decision', 'isError', 'stream']) {
      expect(result).not.toHaveProperty(`data.${field}`);
    }
  });

  it('rejects an unknown top-level live event field and names it', () => {
    const event = {
      ...liveEvent({}),
      tenantSecret: 'must not cross',
    };

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));
    expect(rejection.code).toBe('unknown_field');
    expect(rejection.field).toBe('tenantSecret');
  });

  it.each([
    ['null event', null],
    ['array event', []],
  ])('rejects a malformed %s without throwing', (_label, event) => {
    const rejection = rejectionOf(sanitizeProgressEvent(event as any, identity));
    expect(rejection.code).toBe('invalid_live_event');
    expect(rejection.field).toBeUndefined();
  });

  it.each([
    ['null data', null],
    ['array data', []],
  ])('rejects malformed %s without throwing', (_label, data) => {
    const event = liveEvent({});
    event.data = data;

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));
    expect(rejection.code).toBe('invalid_live_event');
    expect(rejection.field).toBe('data');
  });

  it('rejects an unknown legacy event type', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}, 'unknown:event'), identity));
    expect(rejection.code).toBe('invalid_live_event');
    expect(rejection.field).toBe('type');
  });

  it.each([
    ['authorization', 'credential-shaped key'],
    ['apiKey', 'credential-shaped key'],
    ['authHeaders', 'credential-shaped key'],
    ['headers', 'credential-shaped key'],
    ['promptSnippet', 'prompt'],
    ['prompt', 'prompt'],
    ['diff', 'diff'],
    ['diffBody', 'diff'],
    ['sourceBody', 'source body'],
    ['token', 'raw token'],
    ['tokenText', 'raw token'],
    ['chunk', 'raw model output'],
    ['rawModelOutput', 'raw model output'],
    ['filePath', 'repository-relative path'],
    ['error', 'unbounded error'],
    ['stack', 'unbounded error'],
  ])('rejects %s (%s) at the sanitizer boundary', (field) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ [field]: 'must not cross' }), identity));
    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(field);
  });

  it.each([
    ['provider', 'nats://review:super-secret@nats.internal:4222'],
    ['model', 'https://review:super-secret@example.internal/model'],
  ])('rejects credential material in known %s values without echoing it', (field, value) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ [field]: value }), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(field);
    expect(rejection.message).not.toContain('super-secret');
    expect(rejection.message).not.toContain('nats.internal');
    expect(rejection.message).not.toContain('example.internal');
  });

  it.each([
    ['provider', { provider: 'tls://review:synthetic-secret@private.test:4222' }, 'provider'],
    ['model', { model: 'tls://review:synthetic-secret@private.test:4222' }, 'model'],
    [
      'distinctProviders',
      { distinctProviders: ['openrouter', 'tls://review:synthetic-secret@private.test:4222'] },
      'distinct_providers',
    ],
  ])('rejects scheme-independent credentials in %s', (_label, data, expectedField) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent(data), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(expectedField);
    expect(rejection.message).not.toContain('synthetic-secret');
    expect(rejection.message).not.toContain('private.test');
  });

  it.each([
    ['provider password-only userinfo', { provider: 'tls://:synthetic-secret@private.test:4222' }, 'provider'],
    ['provider username-only userinfo', { provider: 'nats://synthetic-secret@private.test:4222' }, 'provider'],
    ['model password-only userinfo', { model: 'tls://:synthetic-secret@private.test:4222' }, 'model'],
    ['model username-only userinfo', { model: 'nats://synthetic-secret@private.test:4222' }, 'model'],
    [
      'distinctProviders password-only userinfo',
      { distinctProviders: ['tls://:synthetic-secret@private.test:4222'] },
      'distinct_providers',
    ],
    [
      'distinctProviders username-only userinfo',
      { distinctProviders: ['nats://synthetic-secret@private.test:4222'] },
      'distinct_providers',
    ],
  ])('rejects %s without echoing it', (_label, data, expectedField) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent(data), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(expectedField);
    expect(rejection.message).not.toContain('synthetic-secret');
    expect(rejection.message).not.toContain('private.test');
  });

  it.each([
    ['scheme-relative username/password', { provider: '//review:synthetic-secret@private.test:4222' }, 'provider'],
    ['scheme-relative username-only', { model: '//synthetic-secret@private.test:4222' }, 'model'],
    [
      'scheme-relative password-only',
      { distinctProviders: ['//:synthetic-secret@private.test:4222'] },
      'distinct_providers',
    ],
    ['slash-obfuscated authority', { provider: 'https:////review:synthetic-secret@private.test' }, 'provider'],
  ])('rejects %s URL authority credentials in progress data', (_label, data, expectedField) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent(data), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(expectedField);
    expect(rejection.message).not.toContain('synthetic-secret');
    expect(rejection.message).not.toContain('private.test');
  });

  it.each([
    ['attemptId', 'attempt_id', '//review:synthetic-secret@private.test'],
    ['runId', 'run_id', '//synthetic-secret@private.test'],
    ['correlationId', 'correlation_id', '//:synthetic-secret@private.test'],
    ['traceId', 'trace_id', 'https:////review:synthetic-secret@private.test'],
  ] as const)('rejects scheme-relative or obfuscated URL credentials in identity %s', (
    inputField,
    envelopeField,
    value,
  ) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}), {
      ...identity,
      [inputField]: value,
    }));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(envelopeField);
    expect(rejection.message).not.toContain('synthetic-secret');
    expect(rejection.message).not.toContain('private.test');
  });

  it.each([
    ['api-key', 'api-key=synthetic-secret'],
    ['api_key', 'api_key=synthetic-secret'],
    ['apiKey', 'apiKey=synthetic-secret'],
    ['access-token', 'access-token=synthetic-secret'],
    ['access_token', 'access_token=synthetic-secret'],
    ['accessToken', 'accessToken=synthetic-secret'],
    ['refresh-token', 'refresh-token=synthetic-secret'],
    ['refresh_token', 'refresh_token=synthetic-secret'],
    ['refreshToken', 'refreshToken=synthetic-secret'],
    ['client-secret', 'client-secret=synthetic-secret'],
    ['client_secret', 'client_secret=synthetic-secret'],
    ['clientSecret', 'clientSecret=synthetic-secret'],
    ['proxy_authorization', 'proxy_authorization=synthetic-secret'],
    ['proxyAuthorization', 'proxyAuthorization=synthetic-secret'],
    ['x_api_key', 'x_api_key=synthetic-secret'],
    ['xApiKey', 'xApiKey=synthetic-secret'],
    ['private_key', 'private_key=synthetic-secret'],
    ['privateKey', 'privateKey=synthetic-secret'],
  ])('rejects %s credential assignment spelling in progress data', (_label, provider) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ provider }), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe('provider');
    expect(rejection.message).not.toContain('synthetic-secret');
  });

  it.each([
    ['attemptId', 'attempt_id', 'api_key=synthetic-secret'],
    ['runId', 'run_id', 'accessToken=synthetic-secret'],
    ['correlationId', 'correlation_id', 'refresh_token=synthetic-secret'],
    ['traceId', 'trace_id', 'clientSecret=synthetic-secret'],
  ] as const)('rejects credential assignment spelling in identity %s', (inputField, envelopeField, value) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}), {
      ...identity,
      [inputField]: value,
    }));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(envelopeField);
    expect(rejection.message).not.toContain('synthetic-secret');
  });

  it.each([
    ['attemptId', 'attempt_id'],
    ['runId', 'run_id'],
    ['correlationId', 'correlation_id'],
    ['traceId', 'trace_id'],
  ] as const)('rejects credential-bearing URL userinfo in identity %s', (inputField, envelopeField) => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({}), {
      ...identity,
      [inputField]: 'nats://synthetic-secret@private.test:4222',
    }));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe(envelopeField);
    expect(rejection.message).not.toContain('synthetic-secret');
    expect(rejection.message).not.toContain('private.test');
  });

  it.each(credentialLeakMatrix)('rejects credential leak matrix case %s', (_label, location, values) => {
    const results = values.map((value) => {
      const fixture = location.inject(value);
      return sanitizeProgressEvent(fixture.event, fixture.identity);
    });

    expect(results.every((result) => result instanceof ReviewEventRejection)).toBe(true);
    for (const result of results as ReviewEventRejection[]) {
      expect(result.code).toBe('forbidden_field');
      expect(result.field).toBe(location.field);
      expect(result.message).not.toContain('matrix-synthetic-secret');
      expect(result.message).not.toContain('private.test');
    }
  });

  it.each(credentialStringLocations)(
    'rejects all 19 punctuation and slashless URL credential cases in $label',
    (location) => {
      const results = reviewerCredentialUrlLeaks.map((value) => {
        const fixture = location.inject(value);
        return sanitizeProgressEvent(fixture.event, fixture.identity);
      });

      expect(results).toHaveLength(19);
      for (const result of results) {
        const rejection = rejectionOf(result);
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'accepts all 20 path, non-special-scheme, mixed-delimiter, and multiple-span controls in $label',
    (location) => {
      const results = reviewerBenignUrlValues.map((value) => {
        const fixture = location.inject(value);
        return sanitizeProgressEvent(fixture.event, fixture.identity);
      });

      expect(results).toHaveLength(20);
      for (const result of results) expect(result).not.toBeInstanceOf(ReviewEventRejection);
    },
  );

  it.each(credentialStringLocations)(
    'rejects a credential-bearing special URL after a non-special prefix in $label',
    (location) => {
      for (const value of maskedCredentialUrlValues) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'accepts benign special URLs after a non-special prefix in $label',
    (location) => {
      for (const value of maskedCredentialUrlControls) {
        const fixture = location.inject(value);
        expect(sanitizeProgressEvent(fixture.event, fixture.identity))
          .not.toBeInstanceOf(ReviewEventRejection);
      }
    },
  );

  it.each(credentialStringLocations)(
    'rejects wrapped or compact-adjacent credential URLs in $label',
    (location) => {
      for (const value of wrappedOrAdjacentCredentialUrlValues) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'rejects safe-first wrapped or list credential URLs in $label',
    (location) => {
      for (const value of safeFirstWrappedListCredentialUrlValues) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'rejects closing-wrapper and wrapped scheme-relative credential URLs in $label',
    (location) => {
      for (const value of [
        ...closingWrapperAdjacentCredentialUrlValues,
        ...wrappedSchemeRelativeCredentialUrlValues,
      ]) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'owns canonical custom authority path and query content in $label',
    (location) => {
      for (const value of canonicalCustomAuthorityQueryControls) {
        const fixture = location.inject(value);
        expect(sanitizeProgressEvent(fixture.event, fixture.identity))
          .not.toBeInstanceOf(ReviewEventRejection);
      }

      for (const value of canonicalCustomAuthorityCredentialValues) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'rejects credential URLs after malformed or nested decoys in $label',
    (location) => {
      for (const value of decoyMaskedCredentialUrlValues) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));
        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('host.test');
      }
    },
  );

  it('fails closed when the bounded URL candidate budget is exhausted', () => {
    const provider = `${'n:'.repeat(65)}user@example.com`;
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ provider }), identity));

    expect(rejection.code).toBe('forbidden_field');
    expect(rejection.field).toBe('provider');
    expect(rejection.message).not.toContain('user@example.com');
  });

  it.each([
    ['authority-free path email', 'https://private.test/path/user@example.com'],
    ['double-slash URL path email', 'https://host.test/path//user@example.com'],
    ['double-slash URL query email', 'https://host.test/path?next=//user@example.com'],
    ['model revision', 'provider/model@stable'],
    ['ordinary email text', 'contact-user@example.com'],
  ])('does not misclassify @ in %s as URL authority userinfo', (_label, provider) => {
    const result = sanitizeProgressEvent(liveEvent({ provider }), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(result).toHaveProperty('data.provider', provider);
  });

  it.each(credentialStringLocations)(
    'rejects bare username/password authorities in $label',
    (location) => {
      for (const value of [
        'review:synthetic-secret@private.test:4222',
        'review:@private.test:4222',
        ':synthetic-secret@private.test:4222',
        'review:synthetic-secret@nats',
        'review:synthetic-secret@[::1]:4222',
        'review:synthetic:secret@private.test',
        'review:synthetic,secret@private.test',
        'review:synthetic;secret@private.test',
        'review:synthetic=secret@private.test',
        "review:synthetic'part@private.test",
        'review:synthetic(part)@private.test',
        'review:synthetic!$&*+part@private.test',
        'review:synthetic%2Fpart@private.test',
        `:synthetic-secret@sha256:${'a'.repeat(64)}`,
        `review:@sha256:${'a'.repeat(64)}`,
        `review:synthetic-secret@sha256:${'a'.repeat(64)}`,
        `registry/team/review:synthetic-secret@sha256:${'a'.repeat(64)}`,
        'mailto:alice@example.com,review:synthetic-secret@private.test',
        '{review:synthetic-secret@private.test}',
        'review:synthetic-secret@private.test,https://safe.test',
        '["https://safe.test","review:synthetic-secret@private.test"]',
      ]) {
        const fixture = location.inject(value);
        const rejection = rejectionOf(sanitizeProgressEvent(fixture.event, fixture.identity));

        expect(rejection.code).toBe('forbidden_field');
        expect(rejection.field).toBe(location.field);
        expect(rejection.message).not.toContain('synthetic-secret');
        expect(rejection.message).not.toContain('private.test');
      }
    },
  );

  it.each(credentialStringLocations)(
    'accepts benign bare email and revision controls in $label',
    (location) => {
      for (const value of [
        'alice@example.com',
        'mailto:alice@example.com',
        'a@b:c',
        'provider/model@stable',
      ]) {
        const fixture = location.inject(value);
        expect(sanitizeProgressEvent(fixture.event, fixture.identity), value)
          .not.toBeInstanceOf(ReviewEventRejection);
      }
    },
  );

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

  it.each([
    ['null', null],
    ['array', []],
  ])('rejects a malformed %s identity without throwing', (_label, malformedIdentity) => {
    const rejection = rejectionOf(sanitizeProgressEvent(
      liveEvent({}),
      malformedIdentity as unknown as ReviewEventIdentity,
    ));

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

  it('marks only sanitizer output with the opaque progress provenance', () => {
    const result = sanitizeProgressEvent(liveEvent({ provider: 'openrouter' }), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(isSanitizedProgressEvent(result)).toBe(true);
    expect(isSanitizedProgressEvent({ ...result as object })).toBe(false);
  });

  it('maps cyclic input to a typed non-secret rejection', () => {
    const event = liveEvent({});
    (event.data as Record<string, unknown>).cycle = event;

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));

    expect(rejection.code).toBe('not_serializable');
    expect(rejection.message).not.toContain('cycle');
    expect(rejection.message).not.toContain('legacy-job-42');
  });

  it('maps undefined input to a typed non-secret rejection', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(undefined as any, identity));

    expect(rejection.code).toBe('invalid_live_event');
    expect(rejection.message).not.toContain('undefined');
  });

  it('maps BigInt input to a typed non-secret not-serializable rejection', () => {
    const rejection = rejectionOf(sanitizeProgressEvent(liveEvent({ totalTokens: BigInt(12) }), identity));

    expect(rejection.code).toBe('not_serializable');
    expect(rejection.message).not.toContain('12');
  });

  it('rejects a revoked top-level event proxy without allowing Array.isArray to throw', () => {
    const revocable = Proxy.revocable(liveEvent({}), {});
    revocable.revoke();

    const rejection = rejectionOf(sanitizeProgressEvent(revocable.proxy, identity));

    expect(rejection.code).toBe('not_serializable');
  });

  it('rejects a revoked identity proxy without allowing Array.isArray to throw', () => {
    const revocable = Proxy.revocable({ ...identity }, {});
    revocable.revoke();

    const rejection = rejectionOf(sanitizeProgressEvent(
      liveEvent({}),
      revocable.proxy as ReviewEventIdentity,
    ));

    expect(rejection.code).toBe('not_serializable');
  });

  it('rejects a revoked nested proxy without allowing a guard trap to escape', () => {
    const revocable = Proxy.revocable({ provider: 'openrouter' }, {});
    revocable.revoke();
    const event = liveEvent({});
    event.data = revocable.proxy;

    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));

    expect(rejection.code).toBe('not_serializable');
  });

  it.each([
    ['getter', () => {
      let calls = 0;
      const data: Record<string, unknown> = {};
      Object.defineProperty(data, 'provider', {
        enumerable: true,
        get: () => {
          calls += 1;
          return 'openrouter';
        },
      });
      return { event: liveEvent(data), calls: () => calls };
    }],
    ['setter', () => {
      let calls = 0;
      const data: Record<string, unknown> = {};
      Object.defineProperty(data, 'provider', {
        enumerable: true,
        set: () => { calls += 1; },
      });
      return { event: liveEvent(data), calls: () => calls };
    }],
    ['custom prototype', () => {
      let calls = 0;
      const data = Object.create({
        toJSON: () => {
          calls += 1;
          return { provider: 'openrouter' };
        },
      }) as Record<string, unknown>;
      data.provider = 'openrouter';
      return { event: liveEvent(data), calls: () => calls };
    }],
    ['custom array prototype', () => {
      const distinctProviders = ['openrouter'];
      Object.setPrototypeOf(distinctProviders, Object.create(null));
      return { event: liveEvent({ distinctProviders }), calls: () => 0 };
    }],
    ['proxy', () => {
      let calls = 0;
      const data = new Proxy({ provider: 'openrouter' }, {
        ownKeys: (target) => {
          calls += 1;
          return Reflect.ownKeys(target);
        },
      });
      return { event: liveEvent(data), calls: () => calls };
    }],
    ['function value', () => ({
      event: liveEvent({ provider: () => 'synthetic-secret' }),
      calls: () => 0,
    })],
  ])('rejects an inert-boundary %s without executing input code', (_label, makeCase) => {
    const testCase = makeCase();
    const rejection = rejectionOf(sanitizeProgressEvent(testCase.event, identity));

    expect(rejection.code).toBe('not_serializable');
    expect(rejection.field).toBeUndefined();
    expect(testCase.calls()).toBe(0);
  });

  it('ignores non-enumerable and symbol data without invoking a hidden getter', () => {
    let calls = 0;
    const data: Record<PropertyKey, unknown> = { findingsCount: 1 };
    Object.defineProperty(data, 'provider', {
      enumerable: false,
      get: () => {
        calls += 1;
        return 'nats://review:synthetic-secret@private.test';
      },
    });
    data[Symbol('hidden')] = 'symbol-synthetic-secret';

    const result = sanitizeProgressEvent(liveEvent(data as Record<string, unknown>), identity);

    expect(result).not.toBeInstanceOf(ReviewEventRejection);
    expect(result).toMatchObject({ data: { findings_count: 1 } });
    expect(result).not.toHaveProperty('data.provider');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(calls).toBe(0);
  });

  it.each([
    ['depth', (() => {
      let value: Record<string, unknown> = {};
      for (let index = 0; index < 10; index += 1) value = { nested: value };
      return liveEvent({ tokensUsed: value }, 'llm:token');
    })()],
    ['object cardinality', liveEvent(Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`unknown-${index}`, index]),
    ))],
    ['array cardinality', liveEvent({
      distinctProviders: Array.from({ length: 65 }, (_, index) => `provider-${index}`),
    })],
    ['string length', liveEvent({ provider: 'x'.repeat(32_769) })],
  ])('rejects inert input beyond the %s bound', (_label, event) => {
    const rejection = rejectionOf(sanitizeProgressEvent(event, identity));

    expect(rejection.code).toBe('not_serializable');
    expect(rejection.field).toBeUndefined();
  });

  it('does not invoke a rejecting async toJSON hook under strict unhandled-rejection mode', () => {
    const script = `
      const { ReviewEventRejection, sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'strict-attempt',
        runId: 'strict-run',
        sequence: 1,
        correlationId: 'strict-correlation',
        traceId: 'strict-trace',
      };
      let calls = 0;
      const prompt = {
        toJSON() {
          calls += 1;
          return Promise.reject(new Error('tojson-synthetic-secret'));
        },
      };
      const result = sanitizeProgressEvent({
        jobId: 'strict-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data: { prompt },
      }, identity);
      setImmediate(() => process.stdout.write(JSON.stringify({
        code: result instanceof ReviewEventRejection ? result.code : 'accepted',
        calls,
      })));
    `;

    const probe = spawnSync(
      process.execPath,
      ['--unhandled-rejections=strict', '-r', 'ts-node/register/transpile-only', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probe.stdout).toBe('{"code":"not_serializable","calls":0}');
    expect(probe.stderr).not.toContain('tojson-synthetic-secret');
  });

  it('rejects one million enumerable properties under a 128 MB heap without aborting', () => {
    const script = `
      const { ReviewEventRejection, sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'bounded-attempt',
        runId: 'bounded-run',
        sequence: 1,
        correlationId: 'bounded-correlation',
        traceId: 'bounded-trace',
      };
      const data = Object.create(null);
      for (let index = 0; index < 1_048_576; index += 1) data[index] = 0;
      const result = sanitizeProgressEvent({
        jobId: 'bounded-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data,
      }, identity);
      process.stdout.write(JSON.stringify({
        code: result instanceof ReviewEventRejection ? result.code : 'accepted',
      }));
    `;

    const probe = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        '--unhandled-rejections=strict',
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        script,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probe.stdout).toBe('{"code":"not_serializable"}');
    expect(probe.stderr).not.toMatch(/heap|fatal|abort/iu);
  });

  it.each([
    ['numeric', ''],
    ['named', 'hidden_'],
  ] as const)('ignores one million non-enumerable %s properties under a 128 MB heap', (_label, prefix) => {
    const script = `
      const { ReviewEventRejection, sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const { JetStreamProgressSink } = require('./src/events/jetStreamProgressSink.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'hidden-attempt',
        runId: 'hidden-run',
        sequence: 1,
        correlationId: 'hidden-correlation',
        traceId: 'hidden-trace',
      };
      const data = Object.create(null);
      Object.defineProperty(data, 'provider', {
        value: 'nats://review:hidden-synthetic-secret@private.test',
        enumerable: false,
      });
      for (let index = 0; index < 1_048_575; index += 1) {
        Object.defineProperty(data, ${JSON.stringify(prefix)} + index, { value: 0, enumerable: false });
      }
      const event = {
        jobId: 'hidden-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data,
      };
      const payloads = [];
      const sink = new JetStreamProgressSink({
        enabled: true,
        publisher: {
          publish: async (_subject, payload) => payloads.push(new TextDecoder().decode(payload)),
        },
      });
      (async () => {
        const result = sanitizeProgressEvent(event, identity);
        if (!(result instanceof ReviewEventRejection)) await sink.publish(result);
        const payload = payloads[0] || '';
        const published = payload ? JSON.parse(payload) : undefined;
        process.stdout.write(JSON.stringify({
          code: result instanceof ReviewEventRejection ? result.code : 'accepted',
          publishCalls: payloads.length,
          leaked: payload.includes('hidden-synthetic-secret') || payload.includes('private.test'),
          hasProvider: Boolean(published && Object.prototype.hasOwnProperty.call(published.data, 'provider')),
        }));
      })().catch(() => { process.exitCode = 1; });
    `;

    const probe = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        '--unhandled-rejections=strict',
        '-r',
        'ts-node/register/transpile-only',
        '-e',
        script,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probe.stdout).toBe('{"code":"accepted","publishCalls":1,"leaked":false,"hasProvider":false}');
    expect(probe.stderr).not.toMatch(/heap|fatal|abort|hidden-synthetic-secret|private\.test/iu);
  }, 40_000);

  it('bounds credential scanning time for a maximum-length missing-userinfo URL', () => {
    const script = `
      const { sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'bounded-attempt',
        runId: 'bounded-run',
        sequence: 1,
        correlationId: 'bounded-correlation',
        traceId: 'bounded-trace',
      };
      const event = {
        jobId: 'bounded-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data: { provider: 'a://' + 'x'.repeat(32_764) },
      };
      const started = performance.now();
      for (let index = 0; index < 4_000; index += 1) sanitizeProgressEvent(event, identity);
      process.stdout.write(JSON.stringify({ elapsed: performance.now() - started }));
    `;

    const probe = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect((JSON.parse(probe.stdout) as { elapsed: number }).elapsed).toBeLessThan(1_500);
  });

  it('bounds component scanning across repeated URL-path authority lookalikes', () => {
    const script = `
      const { sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'bounded-attempt',
        runId: 'bounded-run',
        sequence: 1,
        correlationId: 'bounded-correlation',
        traceId: 'bounded-trace',
      };
      const event = {
        jobId: 'bounded-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data: {
          provider: 'https://host.test/path' + '//user@example.com'.repeat(1_800),
        },
      };
      const started = performance.now();
      let result;
      for (let index = 0; index < 1_000; index += 1) {
        result = sanitizeProgressEvent(event, identity);
      }
      process.stdout.write(JSON.stringify({
        code: result && result.code,
        elapsed: performance.now() - started,
      }));
    `;

    const probe = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    const output = JSON.parse(probe.stdout) as { code: string; elapsed: number };
    expect(output.code).toBe('invalid_field');
    expect(output.elapsed).toBeLessThan(1_500);
  });

  it('terminates credential scanning for an overlong assignment label', () => {
    const script = `
      const { sanitizeProgressEvent } = require('./src/events/reviewEventRedaction.ts');
      const identity = {
        repositoryId: 123,
        prNumber: 42,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'bounded-attempt',
        runId: 'bounded-run',
        sequence: 1,
        correlationId: 'bounded-correlation',
        traceId: 'bounded-trace',
      };
      sanitizeProgressEvent({
        jobId: 'bounded-job',
        timestamp: '2026-09-11T12:00:00.000Z',
        type: 'persona:complete',
        persona: 'security',
        data: { provider: 'x'.repeat(65) + ':value' },
      }, identity);
      process.stdout.write('completed');
    `;

    const probe = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 },
    );

    expect(probe.status).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probe.stdout).toBe('completed');
  }, 10_000);

  it.each([
    ['cyclic', (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
    ['undefined', undefined],
    ['BigInt', BigInt(42)],
  ])('maps direct parser %s input to a typed static not_serializable error', (_label, value) => {
    let rejection: unknown;
    try {
      parseReviewYetiEventV1(value);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(ReviewEventValidationError);
    expect(rejection).toMatchObject({ code: 'not_serializable' });
    expect(String(rejection)).not.toContain('self');
    expect(String(rejection)).not.toContain('42');
  });
});
