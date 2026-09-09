import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWorkerCompletionAdapter } from '../../src/review/workerCompletion';

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
    'https://dispatch.example.invalid/completion#redirect',
    'http://dispatch.example.invalid/completion',
  ])('rejects unsafe callback endpoint %s', (endpoint) => {
    expect(() => new HttpWorkerCompletionAdapter({ token: 'ghs_test', endpoint }))
      .toThrow(/HTTPS URL without userinfo or fragments/u);
  });
});
