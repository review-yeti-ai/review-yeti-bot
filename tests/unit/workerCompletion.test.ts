import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWorkerCompletionAdapter, validateWorkerCompletionEndpoint, workerTerminalFailureSchema } from '../../src/review/workerCompletion';

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

describe('workerTerminalFailureSchema', () => {
  it('accepts the complete failure identity and permits omission of an uncreated check ID', () => {
    expect(workerTerminalFailureSchema.parse(event)).toEqual(event);
    const { checkId: _checkId, ...withoutCheck } = event;
    expect(workerTerminalFailureSchema.parse(withoutCheck)).toEqual(withoutCheck);
  });

  it.each(['malformed_output', 'internal_error'] as const)('accepts diagnostic failure class %s', (failureClass) => {
    expect(workerTerminalFailureSchema.parse({ ...event, failureClass }).failureClass).toBe(failureClass);
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
