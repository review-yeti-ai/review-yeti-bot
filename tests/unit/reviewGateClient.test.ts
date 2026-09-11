import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_RUN_PAGE_SIZE,
  MAX_CHECK_RUN_PAGES,
  MAX_GATE_RESPONSE_BYTES,
  GitHubReviewGateClient,
} from '../../src/github/reviewGateClient';
import {
  REVIEW_GATE_CHECK_NAME,
  deriveReviewGateExternalId,
  type ReviewGateCoordinates,
} from '../../src/review/reviewCheckIdentity';

const token = 'ghs_review_gate_test_token';
const appId = 4_385_771;
const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const policyDigest = 'c'.repeat(64);

const coordinates: ReviewGateCoordinates = {
  owner: 'calltelemetry',
  repo: 'review-yeti-bot',
  repositoryId: 3210,
  prNumber: 42,
  headSha,
  baseSha,
  policyDigest,
  runId: 'run_' + 'd'.repeat(32),
  attemptId: 'attempt-review-42-g2-a2',
  executionAttempt: 2,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function exactCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 9876,
    name: REVIEW_GATE_CHECK_NAME,
    app: { id: appId },
    head_sha: headSha,
    external_id: deriveReviewGateExternalId(coordinates),
    status: 'queued',
    conclusion: null,
    ...overrides,
  };
}

function client(fetchImplementation: typeof fetch) {
  return new GitHubReviewGateClient({
    token,
    expectedAppId: appId,
    baseUrl: 'https://github.test/api/v3',
    fetchImplementation,
    timeoutMs: 1_000,
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise rejection');
}

describe('GitHubReviewGateClient', () => {
  it('derives an immutable external id from every coordinate', () => {
    const same = deriveReviewGateExternalId({ ...coordinates });
    const changed = deriveReviewGateExternalId({ ...coordinates, executionAttempt: 3 });

    expect(same).toBe(deriveReviewGateExternalId(coordinates));
    expect(same).not.toBe(changed);
    expect(same).toMatch(/^review-yeti-gate:v1:[a-f0-9]{64}$/u);
  });

  it('rejects non-installation tokens and credentialed or fragmented base URLs', () => {
    expect(() => new GitHubReviewGateClient({ token: 'ghp_not_allowed', expectedAppId: appId })).toThrow(/ghs_/u);
    for (const baseUrl of ['https://user:password@github.test/api/v3', 'https://github.test/api/v3#fragment']) {
      expect(() => new GitHubReviewGateClient({ token, expectedAppId: appId, baseUrl })).toThrow(/base URL/u);
    }
  });

  it('requires exact immutable commit, policy, run, and opaque attempt identities', () => {
    expect(() => deriveReviewGateExternalId({ ...coordinates, headSha: 'A'.repeat(40) })).toThrow(/commit identity/u);
    expect(() => deriveReviewGateExternalId({ ...coordinates, baseSha: 'not-a-sha' })).toThrow(/commit identity/u);
    expect(() => deriveReviewGateExternalId({ ...coordinates, policyDigest: 'c'.repeat(63) })).toThrow(/policy digest/u);
    expect(() => deriveReviewGateExternalId({ ...coordinates, runId: 'run_not-an-attempt' })).toThrow(/run id/u);
    expect(() => deriveReviewGateExternalId({ ...coordinates, attemptId: 'attempt id with whitespace' })).toThrow(/attempt id/u);
  });

  it('uses one POST for create and never lets dispatch create a successful check', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response(exactCheck({ status: 'completed', conclusion: 'success' }), 201));
    const gate = client(fetchImplementation);

    await expect(gate.createPending(coordinates)).rejects.toThrow(/terminal/u);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const body = JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      name: REVIEW_GATE_CHECK_NAME,
      head_sha: headSha,
      external_id: deriveReviewGateExternalId(coordinates),
      status: 'queued',
    });
  });

  it('propagates a lost POST acknowledgement without retry, then reconciles the exact App check later', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`token=${token} raw provider response`))
      .mockResolvedValueOnce(response({ total_count: 1, check_runs: [exactCheck()] }));
    const gate = client(fetchImplementation);

    const createError = await rejection(gate.createPending(coordinates));
    expect(createError.message).toBe('GitHub Review Yeti gate request failed');
    expect(createError.message).not.toContain(token);
    expect(fetchImplementation).toHaveBeenCalledOnce();

    await expect(gate.reconcile(coordinates)).resolves.toMatchObject({
      id: 9876,
      appId,
      headSha,
      externalId: deriveReviewGateExternalId(coordinates),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String(fetchImplementation.mock.calls[1][0])).toContain('check_name=Review%20Yeti%20Gate&filter=all');
  });

  it('ignores wrong App, head, and external-id checks and returns only the exact identity', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response({
      total_count: 4,
      check_runs: [
        exactCheck({ id: 1, app: { id: appId + 1 } }),
        exactCheck({ id: 2, head_sha: 'e'.repeat(40) }),
        exactCheck({ id: 3, external_id: 'review-yeti-gate:v1:wrong' }),
        exactCheck({ id: 4 }),
      ],
    }));
    const gate = client(fetchImplementation);

    await expect(gate.reconcile(coordinates)).resolves.toMatchObject({ id: 4, appId, headSha, externalId: deriveReviewGateExternalId(coordinates) });
  });

  it('fails closed on duplicate exact matches and truncated pagination', async () => {
    const duplicateFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ total_count: 2, check_runs: [exactCheck(), exactCheck({ id: 2 })] }));
    await expect(client(duplicateFetch).reconcile(coordinates)).rejects.toThrow(/duplicate/u);

    const truncatedFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ truncated: true, check_runs: [exactCheck()] }));
    await expect(client(truncatedFetch).reconcile(coordinates)).rejects.toThrow(/truncated/u);

    const inconsistentCountFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ total_count: 1, check_runs: [exactCheck(), exactCheck({ id: 2 })] }));
    await expect(client(inconsistentCountFetch).reconcile(coordinates)).rejects.toThrow(/inconsistent/u);
  });

  it('walks all bounded pages before deciding that an exact check is absent or present', async () => {
    const pageOne = Array.from({ length: CHECK_RUN_PAGE_SIZE }, (_, index) => ({ id: index + 1, name: 'Other check' }));
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return page === 1
        ? response({ check_runs: pageOne })
        : response({ check_runs: [exactCheck()] });
    });
    const gate = client(fetchImplementation);

    await expect(gate.reconcile(coordinates)).resolves.toMatchObject({ id: 9876 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String(fetchImplementation.mock.calls[1][0])).toContain('page=2');

    const exhaustedFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return response({
        check_runs: Array.from({ length: CHECK_RUN_PAGE_SIZE }, (_, index) => ({
          id: ((page - 1) * CHECK_RUN_PAGE_SIZE) + index + 1,
          name: 'Other check',
        })),
      });
    });
    await expect(client(exhaustedFetch).reconcile(coordinates)).rejects.toThrow(/pagination exhausted/u);
    expect(exhaustedFetch).toHaveBeenCalledTimes(MAX_CHECK_RUN_PAGES);

    const repeatedFetch = vi.fn<typeof fetch>().mockImplementation(async () => response({ check_runs: pageOne }));
    await expect(client(repeatedFetch).reconcile(coordinates)).rejects.toThrow(/repeated/u);
    expect(repeatedFetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the complete reconcile operation, not only each individual request', async () => {
    const hangingFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const boundedClient = new GitHubReviewGateClient({
      token,
      expectedAppId: appId,
      baseUrl: 'https://github.test/api/v3',
      fetchImplementation: hangingFetch,
      timeoutMs: 1_000,
      reconcileTimeoutMs: 250,
    });

    await expect(boundedClient.reconcile(coordinates)).rejects.toThrow(/timed out|deadline/u);
    expect(hangingFetch).toHaveBeenCalledOnce();
  });

  it('validates the fetched check and updates the same id without creating a replacement', async () => {
    const updated = exactCheck({ status: 'completed', conclusion: 'timed_out' });
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(exactCheck()))
      .mockResolvedValueOnce(response(updated));
    const gate = client(fetchImplementation);

    await expect(gate.updateExisting({
      coordinates,
      checkId: 9876,
      update: { conclusion: 'timed_out', summary: 'bounded timeout' },
    })).resolves.toMatchObject({ id: 9876, status: 'completed', conclusion: 'timed_out' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(fetchImplementation.mock.calls[1][0]).toBe('https://github.test/api/v3/repos/calltelemetry/review-yeti-bot/check-runs/9876');
    expect(fetchImplementation.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'PATCH', redirect: 'error' }));
    const body = JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body));
    expect(body).toMatchObject({ status: 'completed', conclusion: 'timed_out' });
  });

  it('rejects a wrong-identity update and never recreates on a missing check', async () => {
    const wrongAppFetch = vi.fn<typeof fetch>().mockResolvedValue(response(exactCheck({ app: { id: appId + 1 } })));
    await expect(client(wrongAppFetch).updateExisting(coordinates, 9876, { status: 'in_progress' })).rejects.toThrow(/identity/u);
    expect(wrongAppFetch).toHaveBeenCalledOnce();

    const missingFetch = vi.fn<typeof fetch>().mockResolvedValue(response({ message: 'not found', token }, 404));
    const error = await rejection(client(missingFetch).updateExisting(coordinates, 9876, { status: 'in_progress' }));
    expect(error.message).toBe('GitHub Review Yeti gate request failed HTTP 404');
    expect(error.message).not.toContain(token);
    expect(missingFetch).toHaveBeenCalledOnce();
  });

  it('does not expose credentials or raw response bodies in transport errors', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response({ message: `Bad credentials ${token}`, raw: 'provider response' }, 401));
    const error = await rejection(client(fetchImplementation).reconcile(coordinates));

    expect(error.message).toBe('GitHub Review Yeti gate request failed HTTP 401');
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('provider response');
  });

  it.each([
    { status: 'queued', conclusion: 'success' },
    { status: 'in_progress', conclusion: 'failure' },
    { status: 'completed', conclusion: null },
  ])('rejects contradictory observed states: %j', async (state) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response({ total_count: 1, check_runs: [exactCheck(state)] }));
    await expect(client(fetchImplementation).reconcile(coordinates)).rejects.toThrow(/identity/u);
  });

  it('refuses to PATCH a different check ID returned from an exact-id lookup', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response(exactCheck({ id: 1234 })));
    await expect(client(fetchImplementation).updateExisting(coordinates, 9876, { conclusion: 'success' })).rejects.toThrow(/check id/u);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});

describe('GitHubReviewGateClient hard request bounds', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] }));
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  function stream(bytes: Uint8Array, close = true) {
    let sent = false;
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (!sent) { sent = true; controller.enqueue(bytes); }
      else if (close) controller.close();
    });
    return { response: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })), cancel, pull };
  }

  it.each(['GET', 'POST', 'PATCH'] as const)('hard-stops a non-cooperative %s without retry', async (method) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    if (method === 'PATCH') fetcher.mockResolvedValueOnce(response(exactCheck()));
    const gate = client(fetcher);
    const pending = rejection(method === 'GET' ? gate.reconcile(coordinates)
      : method === 'POST' ? gate.createPending(coordinates)
        : gate.updateExisting(coordinates, 9876, { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).message).toBe('GitHub Review Yeti gate request timed out');
    expect(fetcher).toHaveBeenCalledTimes(method === 'PATCH' ? 2 : 1);
    expect(fetcher.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  });

  it('cancels a late fetch body without reading it or continuing to PATCH', async () => {
    let deliver!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { deliver = resolve; }));
    const pending = rejection(client(fetcher).updateExisting(coordinates, 9876, { status: 'in_progress' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).message).toContain('timed out');
    const late = stream(Buffer.from(JSON.stringify(exactCheck())));
    deliver(late.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(late.pull).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['hang', 'throw', 'reject'] as const)('bounds a stuck body even when cancellation will %s', async (behavior) => {
    const reader = {
      read: vi.fn(() => new Promise(() => undefined)),
      cancel: vi.fn(() => {
        if (behavior === 'throw') throw new Error(token);
        if (behavior === 'reject') return Promise.reject(new Error(token));
        return new Promise(() => undefined);
      }),
      releaseLock: vi.fn(),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, body: { getReader: () => reader } } as unknown as Response);
    const pending = rejection(client(fetcher).createPending(coordinates));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).message).toBe('GitHub Review Yeti gate request timed out');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('shares one deadline across fetch and an unfinished JSON body', async () => {
    const wire = stream(Buffer.from(JSON.stringify(exactCheck())), false);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(wire.response), 800);
    }));
    const pending = rejection(client(fetcher).createPending(coordinates));
    await vi.advanceTimersByTimeAsync(999);
    expect(wire.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).message).toContain('timed out');
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.response.body?.locked).toBe(false);
  });

  it('retains the total pagination deadline when the second page ignores abort', async () => {
    const page = Array.from({ length: CHECK_RUN_PAGE_SIZE }, (_, index) => ({ id: index + 1 }));
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { setTimeout(() => resolve(response({ check_runs: page })), 200); }))
      .mockImplementation(() => new Promise(() => undefined));
    const gate = new GitHubReviewGateClient({ token, expectedAppId: appId, fetchImplementation: fetcher,
      timeoutMs: 1_000, reconcileTimeoutMs: 250 });
    const pending = rejection(gate.reconcile(coordinates));
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending).message).toMatch(/timed out|deadline/u);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts exactly the byte bound and never calls an unbounded response.json', async () => {
    const json = JSON.stringify(exactCheck());
    const remote = new Response(json + ' '.repeat(MAX_GATE_RESPONSE_BYTES - Buffer.byteLength(json)));
    const jsonMethod = vi.spyOn(remote, 'json').mockImplementation(() => new Promise(() => undefined));
    const textMethod = vi.spyOn(remote, 'text').mockImplementation(() => new Promise(() => undefined));
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(remote)).createPending(coordinates)).resolves.toMatchObject({ id: 9876 });
    expect(jsonMethod).not.toHaveBeenCalled();
    expect(textMethod).not.toHaveBeenCalled();
    expect(remote.body?.locked).toBe(false);
  });

  it.each(['one chunk', 'multiple chunks', 'multibyte'] as const)('rejects oversized %s by actual bytes and cancels', async (kind) => {
    const json = JSON.stringify(exactCheck({ ignored: kind === 'multibyte' ? 'é'.repeat(MAX_GATE_RESPONSE_BYTES / 2) : '' }));
    const bytes = Buffer.from(kind === 'multibyte' ? json : json + ' '.repeat(MAX_GATE_RESPONSE_BYTES + 1 - Buffer.byteLength(json)));
    const chunks = kind === 'multiple chunks' ? [bytes.subarray(0, MAX_GATE_RESPONSE_BYTES), bytes.subarray(MAX_GATE_RESPONSE_BYTES)] : [bytes];
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
    });
    const remote = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1' } });
    const error = await rejection(client(vi.fn<typeof fetch>().mockResolvedValue(remote)).createPending(coordinates));
    expect(error.message).toBe('GitHub Review Yeti gate response was invalid');
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledTimes(kind === 'multiple chunks' ? 2 : 1);
    expect(remote.body?.locked).toBe(false);
  });

  it.each([Buffer.from(''), Buffer.from(`{${token}`), Buffer.from([0xc3, 0x28])])('rejects invalid JSON/UTF-8 without remote diagnostics', async (bytes) => {
    const remote = stream(bytes);
    const error = await rejection(client(vi.fn<typeof fetch>().mockResolvedValue(remote.response)).createPending(coordinates));
    expect(error.message).toBe('GitHub Review Yeti gate response was invalid');
    expect(error.cause).toBeUndefined();
    expect(error.stack).not.toContain(token);
    expect(remote.response.body?.locked).toBe(false);
  });

  it('redacts a body read exception and releases the reader', async () => {
    const reader = { read: vi.fn().mockRejectedValue(new Error(token)), cancel: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn() };
    const remote = { ok: true, body: { getReader: () => reader } } as unknown as Response;
    const error = await rejection(client(vi.fn<typeof fetch>().mockResolvedValue(remote)).createPending(coordinates));
    expect(error.message).toBe('GitHub Review Yeti gate response was invalid');
    expect(error.cause).toBeUndefined();
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it.each([301, 302, 307, 308, 401, 403, 404, 429, 500])('cancels HTTP %s without consuming an error body', async (status) => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const remote = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(remote);
    expect((await rejection(client(fetcher).createPending(coordinates))).message).toBe(`GitHub Review Yeti gate request failed HTTP ${status}`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pull).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an already-followed redirect even if an injected fetch ignores redirect:error', async () => {
    const wire = stream(Buffer.from(JSON.stringify(exactCheck())));
    Object.defineProperty(wire.response, 'redirected', { value: true });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(wire.response);
    expect((await rejection(client(fetcher).createPending(coordinates))).message).toBe('GitHub Review Yeti gate request failed');
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.pull).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
  });
});
