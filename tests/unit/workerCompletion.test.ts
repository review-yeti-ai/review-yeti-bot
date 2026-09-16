import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkerReviewEvidence, workerReviewEvidenceDigest } from '../../src/review/workerReviewCompletion';
import {
  buildWorkerFailureDiagnostics,
  classifyWorkerFailureMessage,
  HttpWorkerCompletionAdapter,
  MAX_WORKER_FAILURE_LOG_TAIL_BYTES,
  redactWorkerFailureLogTail,
  validateWorkerCompletionEndpoint,
  workerFailureDiagnosticsSchema,
  workerTerminalFailureSchema,
  workerTerminalSuccessDigest,
  workerTerminalSuccessSchema,
} from '../../src/review/workerCompletion';

const event = {
  version: 'WorkerTerminalFailure.v1' as const,
  runId: `run_${'a'.repeat(32)}`,
  repositoryId: 123,
  owner: 'calltelemetry',
  repo: 'ct-meta',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  policyDigest: 'd'.repeat(64),
  configDigest: 'e'.repeat(64),
  executionAttempt: 1,
  checkId: 4242,
  failureClass: 'provider_error' as const,
};

const successEvent = {
  version: 'WorkerTerminalSuccess.v1' as const,
  runId: event.runId,
  repositoryId: event.repositoryId,
  owner: event.owner,
  repo: event.repo,
  prNumber: event.prNumber,
  headSha: event.headSha,
  baseSha: event.baseSha,
  policyDigest: event.policyDigest,
  configDigest: event.configDigest,
  executionAttempt: event.executionAttempt,
  checkId: event.checkId,
};

describe('HttpWorkerCompletionAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['', 'ghp_personal_test', 'eyJ.test.jwt'])('rejects non-installation token %s with a valid endpoint and timeout', (token) => {
    const fetchImplementation = vi.fn();
    expect(() => new HttpWorkerCompletionAdapter({
      token, endpoint: 'https://dispatch.example.invalid/completion', timeoutMs: 250, fetchImplementation,
    })).toThrow(new Error('worker completion requires a ghs_ installation token'));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'worker completion endpoint is required'],
    ['   ', 'worker completion endpoint is required'],
    ['not-a-url', 'worker completion endpoint must be a valid URL'],
    ['https://', 'worker completion endpoint must be a valid URL'],
  ])('rejects missing or malformed endpoint %s after accepting valid credentials', (endpoint, message) => {
    const fetchImplementation = vi.fn();
    expect(() => new HttpWorkerCompletionAdapter({ token: 'ghs_test', endpoint, timeoutMs: 250, fetchImplementation }))
      .toThrow(new Error(message));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('trims a valid HTTPS endpoint', () => {
    expect(validateWorkerCompletionEndpoint('  https://dispatch.example.invalid/completion  '))
      .toBe('https://dispatch.example.invalid/completion');
  });

  it.each([249, 30_001, 250.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects timeout %s with otherwise valid configuration', (timeoutMs) => {
      const fetchImplementation = vi.fn();
      expect(() => new HttpWorkerCompletionAdapter({
        token: 'ghs_test', endpoint: 'https://dispatch.example.invalid/completion', timeoutMs, fetchImplementation,
      })).toThrow(new Error('worker completion timeout must be between 250ms and 30000ms'));
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([250, 30_000])('accepts timeout boundary %s and cancels its timer after success', async (timeoutMs) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(null, { status: 204 });
    });
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test', endpoint: 'https://dispatch.example.invalid/completion', timeoutMs, fetchImplementation,
    });
    await adapter.reportTerminalFailure(event);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(signal?.aborted).toBe(false);
  });

  it('preserves a transport rejection, clears its timer, and never retries the POST', async () => {
    vi.useFakeTimers();
    const original = new Error('network unavailable');
    let signal: AbortSignal | null | undefined;
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      signal = init?.signal;
      throw original;
    });
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test', endpoint: 'https://dispatch.example.invalid/completion', timeoutMs: 250, fetchImplementation,
    });
    await expect(adapter.reportTerminalFailure(event)).rejects.toBe(original);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(signal?.aborted).toBe(false);
  });

  it('posts a typed terminal failure and accepts a successful response', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 202 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      fetchImplementation,
    });

    await adapter.reportTerminalFailure(event);

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://dispatch.example.invalid/api/dispatch/completion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ghs_test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(event),
      }),
    );
  });

  it('posts the strict terminal-success event through the same authenticated endpoint', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 200 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      fetchImplementation,
    });

    await adapter.reportTerminalSuccess(successEvent);

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://dispatch.example.invalid/api/dispatch/completion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ghs_test' }),
        body: JSON.stringify(successEvent),
        redirect: 'error',
      }),
    );
  });

  it('disables redirects on the callback request', async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 204 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      fetchImplementation,
    });

    await adapter.reportTerminalFailure(event);

    expect((fetchImplementation as any).mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'error' }));
  });

  it('fails on an HTTP error without exposing a response body', async () => {
    const fetchImplementation = vi.fn(async () => new Response('sensitive upstream body', { status: 503 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      fetchImplementation,
    });

    await expect(adapter.reportTerminalFailure(event)).rejects.toThrow(/HTTP 503/u);
    await expect(adapter.reportTerminalFailure(event)).rejects.not.toThrow(/sensitive upstream body/u);
  });

  it('aborts a callback that exceeds the bounded timeout', async () => {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('callback aborted')));
    }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.invalid/api/dispatch/completion',
      timeoutMs: 250,
      fetchImplementation,
    });

    const pending = adapter.reportTerminalFailure(event);
    const rejection = expect(pending).rejects.toThrow(/callback aborted/u);
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
  });

  it.each([
    'https://user:password@dispatch.example.invalid/completion',
    'https://user@dispatch.example.invalid/completion',
    'https://:password@dispatch.example.invalid/completion',
    'https://dispatch.example.invalid/completion#redirect',
    'http://dispatch.example.invalid/completion',
  ])('rejects unsafe callback endpoint %s', (endpoint) => {
    expect(() => new HttpWorkerCompletionAdapter({ token: 'ghs_test', endpoint }))
      .toThrow(/HTTPS URL without userinfo or fragments/u);
  });
});

describe('workerTerminalSuccessSchema', () => {
  it('accepts only the exact success identity with a required check ID', () => {
    expect(workerTerminalSuccessSchema.parse(successEvent)).toEqual(successEvent);
    expect(workerTerminalSuccessSchema.safeParse({ ...successEvent, checkId: undefined }).success).toBe(false);
    expect(workerTerminalSuccessSchema.safeParse({ ...successEvent, conclusion: 'success' }).success).toBe(false);
  });

  it('derives a stable digest from the canonical validated event', () => {
    expect(workerTerminalSuccessDigest(successEvent)).toMatch(/^[a-f0-9]{64}$/u);
    expect(workerTerminalSuccessDigest({ ...successEvent })).toBe(workerTerminalSuccessDigest(successEvent));
    expect(workerTerminalSuccessDigest({ ...successEvent, checkId: 4243 }))
      .not.toBe(workerTerminalSuccessDigest(successEvent));
  });

  it.each([
    ['version', 'WorkerTerminalSuccess.v2'],
    ['runId', `run_${'a'.repeat(31)}`],
    ['repositoryId', 0],
    ['owner', 'owner/another'],
    ['repo', 'repo with spaces'],
    ['prNumber', 0],
    ['headSha', 'b'.repeat(39)],
    ['baseSha', 'C'.repeat(40)],
    ['policyDigest', 'd'.repeat(63)],
    ['configDigest', 'E'.repeat(64)],
    ['executionAttempt', 0],
    ['checkId', 0],
  ])('rejects invalid %s', (field, invalid) => {
    expect(workerTerminalSuccessSchema.safeParse({ ...successEvent, [field]: invalid }).success).toBe(false);
  });
});

describe('workerTerminalFailureSchema', () => {
  it('accepts the complete failure identity and permits omission of an uncreated check ID', () => {
    expect(workerTerminalFailureSchema.parse(event)).toEqual(event);
    const { checkId: _checkId, ...withoutCheck } = event;
    expect(workerTerminalFailureSchema.parse(withoutCheck)).toEqual(withoutCheck);
  });

  it.each(['malformed_output', 'internal_error'] as const)('accepts diagnostic failure class %s', (failureClass) => {
    expect(workerTerminalFailureSchema.parse({ ...event, failureClass }).failureClass).toBe(failureClass);
  });

  it('accepts a bounded redacted diagnostic with provider status and rejects oversized tails', () => {
    const diagnostics = { reason: 'provider_rate_limited', providerStatus: 429, logTail: '429 [REDACTED]' };
    expect(workerTerminalFailureSchema.parse({ ...event, diagnostics }).diagnostics).toEqual(diagnostics);
    expect(workerFailureDiagnosticsSchema.safeParse({
      ...diagnostics, logTail: '🙂'.repeat(MAX_WORKER_FAILURE_LOG_TAIL_BYTES),
    }).success).toBe(false);
    expect(workerFailureDiagnosticsSchema.safeParse({ ...diagnostics, providerStatus: 99 }).success).toBe(false);
  });

  it('redacts token, assignment, and free-form provider context before building diagnostics', () => {
    const message = 'HTTP 429 api_key=super-secret ghs_123456789 private provider response body';
    expect(redactWorkerFailureLogTail(message)).toBe('HTTP 429 api_key=[REDACTED] [REDACTED] [REDACTED]');
    expect(buildWorkerFailureDiagnostics(Object.assign(new Error(message), { status: 429 }), 'rate_limit')).toEqual({
      reason: 'provider_rate_limited', providerStatus: 429, logTail: 'HTTP 429 api_key=[REDACTED] [REDACTED] [REDACTED]',
    });
  });

  it('gives HTTP 406 on the GitHub qualification read its own reason and provider status when the caller says so', () => {
    // The caller (publishingReview.ts) holds the original error and decides
    // whether it is the GitHub-diff-too-large case via the structured
    // `httpStatus` field on GitHubQualificationReadError; this module has no
    // dependency on github/ types or message parsing and only trusts the
    // `githubDiffNotRenderable` flag it is given.
    const message = 'GitHub qualification read failed HTTP 406';
    const diagnostics = buildWorkerFailureDiagnostics(new Error(message), 'contract', { githubDiffNotRenderable: true });
    expect(diagnostics.reason).toBe('github_diff_not_renderable');
    expect(diagnostics.providerStatus).toBe(406);
    expect(diagnostics.logTail).toContain('406');
    expect(diagnostics.logTail).toContain('too large');
    expect(diagnostics.logTail).toContain(message);
  });

  it.each([429, 404, 401, 403, 406, 500, 502])(
    'does not apply the diff-not-renderable reason for HTTP %s unless the caller sets the flag',
    (status) => {
      const message = `GitHub qualification read failed HTTP ${status}`;
      const diagnostics = buildWorkerFailureDiagnostics(new Error(message), 'contract');
      expect(diagnostics.reason).not.toBe('github_diff_not_renderable');
      expect(diagnostics.reason).toBe('worker_contract_invalid');
    },
  );

  it('redacts opaque JWT and AWS access-key shapes even without a known token prefix', () => {
    const jwt = 'eyJaaaaaaaa.bbbbbbbb.cccccccc';
    const awsAccessKey = `ASIA${'A'.repeat(16)}`;
    const message = `provider detail ${jwt} AWS_ACCESS_KEY_ID=${awsAccessKey} AWS_SECRET_ACCESS_KEY=synthetic-secret`;
    const redacted = redactWorkerFailureLogTail(message);
    expect(redacted).toBe('provider detail [REDACTED] AWS_ACCESS_KEY_ID=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain(awsAccessKey);
  });

  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ])('redacts complete PEM %s blocks without retaining key material', (label) => {
    const secret = `pem-secret-${label.toLowerCase().replace(/\s+/gu, '-')}`;
    const pem = `-----BEGIN ${label}-----\n${secret}\n-----END ${label}-----`;
    const redacted = redactWorkerFailureLogTail(`provider failure ${pem} after`);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(`BEGIN ${label}`);
    expect(redacted).not.toContain(`END ${label}`);
    expect(redacted).toBe('provider failure [REDACTED] after');
  });

  it('redacts an unterminated PEM private-key block through the bounded log tail', () => {
    const secret = 'unterminated-pem-secret';
    const redacted = redactWorkerFailureLogTail(`provider failure -----BEGIN RSA PRIVATE KEY-----\n${secret}`);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(redacted).toBe('provider failure [REDACTED]');
  });

  it('keeps the UTF-8 tail bound when truncation starts inside a multibyte code point', () => {
    const tail = redactWorkerFailureLogTail(`${'🙂'.repeat(1024)}x`);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(MAX_WORKER_FAILURE_LOG_TAIL_BYTES);
    expect(tail).not.toContain('\uFFFD');
  });

  it.each([
    ['version', 'WorkerTerminalFailure.v2'],
    ['runId', `run_${'a'.repeat(31)}`],
    ['owner', 'owner/another'],
    ['repo', 'repo with spaces'],
    ['headSha', 'b'.repeat(39)],
    ['baseSha', 'C'.repeat(40)],
    ['policyDigest', 'd'.repeat(63)],
    ['configDigest', 'E'.repeat(64)],
    ['failureClass', 'success'],
  ])('rejects invalid %s without another invalid field hiding the guard', (field, invalid) => {
    const parsed = workerTerminalFailureSchema.safeParse({ ...event, [field]: invalid });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error(`invalid ${field} was accepted`);
    expect(parsed.error.issues.map((issue) => issue.path)).toEqual([[field]]);
  });

  describe.each(['repositoryId', 'prNumber', 'executionAttempt', 'checkId'] as const)('%s', (field) => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1'])(
      'rejects invalid positive safe integer %s', (invalid) => {
        const parsed = workerTerminalFailureSchema.safeParse({ ...event, [field]: invalid });
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error(`invalid ${field} was accepted`);
        expect(parsed.error.issues.length).toBeGreaterThan(0);
        expect(parsed.error.issues.every((issue) => issue.path.join('.') === field)).toBe(true);
      },
    );

    it.each([1, Number.MAX_SAFE_INTEGER])('accepts positive safe integer boundary %s', (value) => {
      expect(workerTerminalFailureSchema.parse({ ...event, [field]: value })[field]).toBe(value);
    });
  });

  it.each(['error', 'workerTokenDigest', 'approved'])(
    'rejects untrusted extra field %s on an otherwise valid event', (field) => {
      const parsed = workerTerminalFailureSchema.safeParse({ ...event, [field]: 'not-authoritative' });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error(`extra ${field} was accepted`);
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
      ]);
    },
  );
});


describe('WorkerTerminalSuccess.v1 optional review result', () => {
  const base = {
    version: 'WorkerTerminalSuccess.v1' as const,
    runId: 'run_' + 'a'.repeat(32), repositoryId: 7, owner: 'o', repo: 'r', prNumber: 1,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    executionAttempt: 1, checkId: 9,
  };
  const result = { version: 'WorkerReviewResult.v1', completedAt: '2026-09-14T00:00:00Z',
    personas: [{ id: 'sec', decision: 'FINDINGS', findings: [{ severity: 'P2', path: 'a.ts', line: 1, title: 't', body: 'b' }] }],
    coverageComplete: true, quorumSatisfied: true };

  it('accepts a terminal success with and without a result, and still rejects unknown keys', () => {
    expect(workerTerminalSuccessSchema.safeParse(base).success).toBe(true);
    expect(workerTerminalSuccessSchema.safeParse({ ...base, result }).success).toBe(true);
    expect(workerTerminalSuccessSchema.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });

  it('keeps the lifecycle identity digest independent of the evidence', () => {
    // A retry that omits or repeats the result is the same terminal success,
    // not a conflicting one.
    expect(workerTerminalSuccessDigest({ ...base, result })).toBe(workerTerminalSuccessDigest(base));
    expect(workerTerminalSuccessDigest({ ...base, checkId: 10 })).not.toBe(workerTerminalSuccessDigest(base));
  });
});


describe('WorkerReviewEvidence.v1', () => {
  const evidence = {
    version: 'WorkerReviewEvidence.v1' as const,
    runId: 'run_' + 'a'.repeat(32), repositoryId: 7, owner: 'o', repo: 'r', prNumber: 1,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    executionAttempt: 1, checkId: 9, conclusion: 'failure' as const,
    result: { version: 'WorkerReviewResult.v1' as const, completedAt: '2026-09-16T00:00:00Z',
      personas: [{ id: 'sec', decision: 'FINDINGS' as const, findings: [{ severity: 'P1' as const, path: 'a.ts', line: 1, title: 't', body: 'b' }] }],
      coverageComplete: true, quorumSatisfied: true },
  };

  it('parses, digests deterministically, and rejects unknown keys, other conclusions and oversize bodies', () => {
    expect(parseWorkerReviewEvidence(evidence)).toEqual(evidence);
    expect(workerReviewEvidenceDigest(evidence)).toMatch(/^[a-f0-9]{64}$/u);
    expect(workerReviewEvidenceDigest({ ...evidence, conclusion: 'success' })).not.toBe(workerReviewEvidenceDigest(evidence));
    expect(() => parseWorkerReviewEvidence({ ...evidence, extra: 1 })).toThrow(/WorkerReviewEvidence/u);
    expect(() => parseWorkerReviewEvidence({ ...evidence, conclusion: 'neutral' })).toThrow();
    const oversize = { ...evidence, result: { ...evidence.result, personas: [{ id: 'sec', decision: 'FINDINGS' as const,
      findings: Array.from({ length: 400 }, (_, i) => ({ severity: 'P2' as const, path: 'a.ts', line: 1, title: `f${i}`, body: 'x'.repeat(10_000) })) }] } };
    expect(() => parseWorkerReviewEvidence(oversize)).toThrow(/exceeds/u);
  });

  it('is posted by the HTTP adapter to the completion endpoint with the worker bearer', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(null, { status: 200 });
    });
    const adapter = new HttpWorkerCompletionAdapter({ token: 'ghs_test', endpoint: 'https://dispatch.example.invalid/completion', fetchImplementation });
    await adapter.reportReviewEvidence(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://dispatch.example.invalid/completion');
    expect(calls[0].auth).toBe('Bearer ghs_test');
    expect(calls[0].body).toEqual(evidence);
  });
});

// REL-892: `classifyWorkerFailureMessage` is the single shared message/status-pattern
// implementation both `classifyFailure` (../cli/publishingReview) and
// `classifyPersonaAttemptFailure` (../panel/panelEngine) delegate their non-typed-error
// remainder to, replacing what used to be two independently-drifting regex ladders. Each branch
// here is exercised directly against the shared function; `publishingReview.test.ts` and
// `panelFailureClassification.test.ts` separately confirm each call site's typed `instanceof`
// pre-checks still take priority and that both call sites still agree with this table.
describe('classifyWorkerFailureMessage', () => {
  it.each([
    ['turn budget exhausted', 'budget_exhausted'],
    ['persona sec-lane exceeded total retry/execution budget of 900s', 'budget_exhausted'],
    ['request timed out', 'timeout'],
    ['OpenRouter compatibility response exceeded total deadline of 300000ms', 'timeout'],
    ['virtual key not found', 'auth'],
    ['401 unauthorized', 'auth'],
    ['403 forbidden', 'auth'],
    ['429 rate limit exceeded', 'rate_limit'],
    ['upstream rate limit hit', 'rate_limit'],
    ['ENOTFOUND api.example.invalid', 'transport'],
    ['ECONNREFUSED', 'transport'],
    ['EAI_AGAIN', 'transport'],
    ['fetch failed', 'transport'],
    ['invalid native JSON response object', 'malformed_output'],
    ['invalid or missing native JSON nonce', 'malformed_output'],
    ['native JSON response must be an object', 'malformed_output'],
    ['invalid findings contract at index 0', 'malformed_output'],
    ['APPROVE cannot contain findings', 'malformed_output'],
    ['FINDINGS requires at least one finding', 'malformed_output'],
    ['nonce-fenced structured output rejected', 'malformed_output'],
    ['persona sec-lane reported INCOMPLETE without a completed review', 'malformed_output'],
    ['An optional reviewer did not complete.', 'malformed_output'],
    ['gateway returned an unexpected payload', 'provider_error'],
    ['provider request rejected', 'provider_error'],
    ['model overloaded', 'provider_error'],
    ['unexpected invariant violation', 'internal_error'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyWorkerFailureMessage(new Error(message))).toBe(expected);
  });

  it('classifies a non-Error thrown value by its string form', () => {
    expect(classifyWorkerFailureMessage('429 rate limit')).toBe('rate_limit');
  });

  it('defaults to internal_error for a message matching no pattern', () => {
    expect(classifyWorkerFailureMessage(new Error('something odd happened'))).toBe('internal_error');
  });
});
