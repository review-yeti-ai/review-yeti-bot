import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkerReviewEvidence, workerReviewEvidenceDigest } from '../../src/review/workerReviewCompletion';
import {
  buildDurableWorkerFailureDiagnostics,
  buildWorkerFailureDiagnostics,
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

  it('sets recoverableIncompletePanel only when the caller passes it true, and validates it as a bounded boolean', () => {
    expect(buildWorkerFailureDiagnostics(new Error('provider HTTP 502'), 'provider_error'))
      .not.toHaveProperty('recoverableIncompletePanel');
    expect(buildWorkerFailureDiagnostics(new Error('provider HTTP 502'), 'provider_error', false))
      .not.toHaveProperty('recoverableIncompletePanel');
    expect(buildWorkerFailureDiagnostics(new Error('provider HTTP 502'), 'provider_error', true))
      .toMatchObject({ recoverableIncompletePanel: true });
    expect(workerFailureDiagnosticsSchema.safeParse({
      reason: 'provider_request_failed', logTail: 'ok', recoverableIncompletePanel: true,
    }).success).toBe(true);
    expect(workerFailureDiagnosticsSchema.safeParse({
      reason: 'provider_request_failed', logTail: 'ok', recoverableIncompletePanel: 'true',
    }).success).toBe(false);
  });

  it('carries recoverableIncompletePanel into the durable diagnostics only when true', () => {
    expect(buildDurableWorkerFailureDiagnostics('malformed_output', { recoverableIncompletePanel: true }))
      .toMatchObject({ recoverableIncompletePanel: true });
    expect(buildDurableWorkerFailureDiagnostics('malformed_output', { recoverableIncompletePanel: false }))
      .not.toHaveProperty('recoverableIncompletePanel');
    expect(buildDurableWorkerFailureDiagnostics('malformed_output')).not.toHaveProperty('recoverableIncompletePanel');
  });

  it('redacts token, assignment, and free-form provider context before building diagnostics', () => {
    const message = 'HTTP 429 api_key=super-secret ghs_123456789 private provider response body';
    expect(redactWorkerFailureLogTail(message)).toBe('HTTP 429 api_key=[REDACTED] [REDACTED] [REDACTED]');
    expect(buildWorkerFailureDiagnostics(Object.assign(new Error(message), { status: 429 }), 'rate_limit')).toEqual({
      reason: 'provider_rate_limited', providerStatus: 429, logTail: 'HTTP 429 api_key=[REDACTED] [REDACTED] [REDACTED]',
    });
  });

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
