import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpWorkerReviewCompletionAdapter,
  MAX_WORKER_REVIEW_RESPONSE_BYTES,
  type WorkerReviewCompletionAdapter,
} from '../../src/review/workerReviewCompletionHttp';
import { MAX_COMPLETION_BYTES, parseWorkerReviewCompletion, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';

const token = 'ghs_Synthetic-Worker.header_segment.signature-with-dash';
const endpoint = 'https://dispatch.example.invalid/api/dispatch/completion';
const diagnostic = 'SYNTHETIC_PRIVATE_PROVIDER_TRANSCRIPT';
const reportError = 'Worker review completion could not be acknowledged';
const configError = 'Worker review completion transport configuration is invalid';

function event(): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: `run_${'a'.repeat(32)}`,
    repositoryId: 123, owner: 'calltelemetry', repo: 'review-yeti-bot', prNumber: 42,
    headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyDigest: 'd'.repeat(64),
    configDigest: 'e'.repeat(64), executionAttempt: 2,
    result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T12:00:00.000Z',
      personas: [{ id: 'security', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      coverageComplete: true, quorumSatisfied: true },
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return { version: 'WorkerReviewCompletionAccepted.v1', runId: event().runId, status: 'recorded', ...overrides };
}

function fixture(response = new Response(JSON.stringify(receipt())), timeoutMs?: number) {
  const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  const adapter = new HttpWorkerReviewCompletionAdapter({ token, endpoint, timeoutMs, fetchImplementation });
  return { adapter, fetchImplementation };
}

async function expectRedacted(pending: Promise<unknown>, message = reportError): Promise<void> {
  const error = await pending.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
  expect((error as Error).cause).toBeUndefined();
  expect(`${(error as Error).stack}\n${JSON.stringify(error)}`).not.toContain(token);
  expect(`${(error as Error).stack}\n${JSON.stringify(error)}`).not.toContain(diagnostic);
}

function sizedEvent(bytes: number): WorkerReviewCompletion {
  const result = event();
  result.result.personas[0].decision = 'FINDINGS';
  result.result.personas[0].findings = Array.from({ length: 64 }, () => ({
    severity: 'P1', path: 'src/example.ts', line: 1, title: 'Finding', body: 'x',
  }));
  let remaining = bytes - Buffer.byteLength(JSON.stringify(result), 'utf8');
  for (const finding of result.result.personas[0].findings) {
    const added = Math.min(15_999, remaining);
    finding.body += 'x'.repeat(added);
    remaining -= added;
  }
  expect(remaining).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(bytes);
  return result;
}

function streamingResponse(chunks: Uint8Array[], close = true) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index < chunks.length) controller.enqueue(chunks[index++]);
    else if (close) controller.close();
  });
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { response: new Response(stream), cancel, pull };
}

describe('HttpWorkerReviewCompletionAdapter', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); }
  });

  it.each(['recorded', 'duplicate', 'ignored'])('accepts only a delivery acknowledgement for %s', async (status) => {
    const f = fixture(new Response(JSON.stringify(receipt({ status }))));
    const payload = event();
    const snapshot = structuredClone(payload);
    const adapter: WorkerReviewCompletionAdapter = f.adapter;
    // No verdict or proof is returned, including for ignored/recorded receipts.
    expect(await adapter.reportReviewResult(payload)).toBeUndefined();
    expect(payload).toEqual(snapshot);
    expect(f.fetchImplementation).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parseWorkerReviewCompletion(snapshot)), signal: expect.any(AbortSignal),
    });
    expect(String(f.fetchImplementation.mock.calls[0][0])).not.toContain(token);
    expect(f.fetchImplementation.mock.calls[0][1]?.body).not.toContain(token);
    expect(f.fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('snapshots the payload before awaiting the response', async () => {
    const f = fixture();
    const payload = event();
    const pending = f.adapter.reportReviewResult(payload);
    payload.runId = `run_${'f'.repeat(32)}`;
    payload.result.personas[0].id = 'later-change';
    await pending;
    expect(JSON.parse(String(f.fetchImplementation.mock.calls[0][1]?.body))).toEqual(event());
  });

  it('normalizes the existing HTTPS endpoint without putting credentials in the URL', async () => {
    const f = fixture();
    const options = Object.freeze({ token, endpoint: `  ${endpoint}  `, fetchImplementation: f.fetchImplementation });
    const adapter = new HttpWorkerReviewCompletionAdapter(options);
    await adapter.reportReviewResult(event());
    expect(f.fetchImplementation.mock.calls[0][0]).toBe(endpoint);
    expect(options.endpoint).toBe(`  ${endpoint}  `);
  });

  it.each(['', 'ghs_', 'ghp_personal', 'github_pat_personal', 'Bearer ghs_test', ' ghs_test', 'ghs_test ',
    'ghs_test\n', 'ghs_test\r\nAuthorization: other', 'ghs_test?key', 'ghs_test/other', 'ghs_test-abc',
    'ghs_one.two', 'ghs_one.two.three.four', 'ghs_one.two.bad/slash', 'ghs_tést'])
  ('rejects non-exact installation credential %j before I/O', (credential) => {
    const fetchImplementation = vi.fn();
    expect(() => new HttpWorkerReviewCompletionAdapter({ token: credential, endpoint, fetchImplementation })).toThrow(configError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['', 'not-a-url', 'http://dispatch.example.invalid/api/dispatch/completion',
    `https://${token}@dispatch.example.invalid/api/dispatch/completion`,
    `https://user:${token}@dispatch.example.invalid/api/dispatch/completion`,
    `${endpoint}#fragment`, `${endpoint}?`, `${endpoint}?token=${token}`, `${endpoint}?safe=true`])
  ('rejects unsafe endpoint %j with a static configuration error', (url) => {
    const fetchImplementation = vi.fn();
    expect(() => new HttpWorkerReviewCompletionAdapter({ token, endpoint: url, fetchImplementation })).toThrow(configError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([249, 30_001, 250.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects timeout %s', (timeoutMs) => {
    expect(() => fixture(undefined, timeoutMs)).toThrow(configError);
  });

  it.each([250, 30_000])('accepts timeout boundary %s without leaving a timer', async (timeoutMs) => {
    const f = fixture(undefined, timeoutMs);
    await f.adapter.reportReviewResult(event());
    expect(f.fetchImplementation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { version: 'WorkerTerminalFailure.v1' }, { runId: 'invalid' }, { executionAttempt: 0 },
    { checkId: 1 }, { conclusion: 'success' }, { url: endpoint }, { override: true },
    { workerTokenDigest: 'f'.repeat(64) }, { result: { ...event().result, rawTranscript: diagnostic } },
    { result: { ...event().result, personas: [{ ...event().result.personas[0], error: diagnostic }] } },
    { result: { ...event().result, personas: [{ ...event().result.personas[0], required: false }] } },
  ])('rejects malformed/untrusted outgoing fields %j without sending', async (override) => {
    const f = fixture();
    const payload = { ...event(), ...override } as WorkerReviewCompletion;
    await expectRedacted(f.adapter.reportReviewResult(payload));
    expect(f.fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects serialization errors without retaining the original exception', async () => {
    const f = fixture();
    const payload = event();
    Object.defineProperty(payload, 'runId', { enumerable: true, get: () => { throw new Error(`${token} ${diagnostic}`); } });
    await expectRedacted(f.adapter.reportReviewResult(payload));
    expect(f.fetchImplementation).not.toHaveBeenCalled();
  });

  it('allows exactly one million outgoing UTF-8 bytes and rejects one extra byte', async () => {
    const f = fixture();
    const exact = sizedEvent(MAX_COMPLETION_BYTES);
    await f.adapter.reportReviewResult(exact);
    expect(Buffer.byteLength(String(f.fetchImplementation.mock.calls[0][1]?.body), 'utf8')).toBe(MAX_COMPLETION_BYTES);
    const over = fixture();
    await expectRedacted(over.adapter.reportReviewResult(sizedEvent(MAX_COMPLETION_BYTES + 1)));
    expect(over.fetchImplementation).not.toHaveBeenCalled();
  });

  it('bounds outgoing UTF-8 bytes rather than JavaScript characters', async () => {
    const payload = sizedEvent(MAX_COMPLETION_BYTES);
    payload.result.personas[0].findings[0].body = 'é'.repeat(16_000);
    expect(JSON.stringify(payload).length).toBe(MAX_COMPLETION_BYTES);
    const f = fixture();
    await expectRedacted(f.adapter.reportReviewResult(payload));
    expect(f.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([201, 202, 204, 301, 302, 307, 308, 400, 401, 403, 409, 429, 500, 503])
  ('rejects HTTP %s without reading its body or retrying', async (status) => {
    const wire = streamingResponse([Buffer.from(diagnostic)], false);
    const response = new Response(status === 204 ? null : wire.response.body, { status });
    const f = fixture(response);
    await expectRedacted(f.adapter.reportReviewResult(event()));
    expect(f.fetchImplementation).toHaveBeenCalledOnce();
    expect(wire.pull).not.toHaveBeenCalled();
    if (status !== 204) expect(wire.cancel).toHaveBeenCalledOnce();
  });

  it('rejects a followed redirect even if a fetch implementation returns HTTP 200', async () => {
    const wire = streamingResponse([Buffer.from(JSON.stringify(receipt()))], false);
    Object.defineProperty(wire.response, 'redirected', { value: true });
    const f = fixture(wire.response);
    await expectRedacted(f.adapter.reportReviewResult(event()));
    expect(wire.pull).not.toHaveBeenCalled();
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(f.fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    '', diagnostic, 'null', '[]', '{}', JSON.stringify({ ...receipt(), runId: `run_${'f'.repeat(32)}` }),
    JSON.stringify(receipt({ version: 'WorkerReviewCompletionAccepted.v2' })),
    JSON.stringify(receipt({ status: 'accepted' })), JSON.stringify(receipt({ status: 'success' })),
    JSON.stringify(receipt({ status: null })), JSON.stringify(receipt({ status: undefined })),
    JSON.stringify(receipt({ conclusion: 'success' })), JSON.stringify(receipt({ transcript: diagnostic })),
  ])('rejects malformed or nonmatching receipt %j', async (body) => {
    const f = fixture(new Response(body));
    await expectRedacted(f.adapter.reportReviewResult(event()));
    expect(f.fetchImplementation).toHaveBeenCalledOnce();
  });

  it('rejects a missing response stream', async () => {
    await expectRedacted(fixture(new Response(null)).adapter.reportReviewResult(event()));
  });

  it('reads a chunked receipt at exactly the 16 KiB boundary', async () => {
    const json = JSON.stringify(receipt());
    const bytes = Buffer.from(json + ' '.repeat(MAX_WORKER_REVIEW_RESPONSE_BYTES - Buffer.byteLength(json)));
    const wire = streamingResponse([bytes.subarray(0, 5), bytes.subarray(5, 99), bytes.subarray(99)]);
    await fixture(wire.response).adapter.reportReviewResult(event());
    expect(wire.response.body?.locked).toBe(false);
  });

  it.each(['single chunk', 'chunked', 'lying content-length'])('rejects a response exceeding 16 KiB: %s', async (kind) => {
    const json = JSON.stringify(receipt());
    const bytes = Buffer.from(json + ' '.repeat(MAX_WORKER_REVIEW_RESPONSE_BYTES - Buffer.byteLength(json) + 1));
    const chunks = kind === 'chunked' ? [bytes.subarray(0, MAX_WORKER_REVIEW_RESPONSE_BYTES), bytes.subarray(MAX_WORKER_REVIEW_RESPONSE_BYTES)] : [bytes];
    const wire = streamingResponse(chunks, false);
    if (kind === 'lying content-length') wire.response.headers.set('content-length', '1');
    await expectRedacted(fixture(wire.response).adapter.reportReviewResult(event()));
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.response.body?.locked).toBe(false);
  });

  it('bounds multibyte response bytes and rejects invalid UTF-8', async () => {
    const wire = streamingResponse([Buffer.from('é'.repeat(MAX_WORKER_REVIEW_RESPONSE_BYTES / 2 + 1))], false);
    await expectRedacted(fixture(wire.response).adapter.reportReviewResult(event()));
    expect(wire.cancel).toHaveBeenCalledOnce();
    const invalid = Buffer.concat([Buffer.from(JSON.stringify(receipt())), Buffer.from([0xff])]);
    await expectRedacted(fixture(new Response(invalid)).adapter.reportReviewResult(event()));
  });

  it.each(['throw', 'reject'])('redacts a fetch %s and makes only one attempt', async (kind) => {
    const fetchImplementation = vi.fn((): Promise<Response> => {
      if (kind === 'throw') throw new Error(`${token} ${diagnostic}`);
      return Promise.reject(new Error(`${token} ${diagnostic}`));
    });
    const adapter = new HttpWorkerReviewCompletionAdapter({ token, endpoint, fetchImplementation });
    await expectRedacted(adapter.reportReviewResult(event()));
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([undefined, 250, 30_000])('bounds uncooperative fetch with timeout %s (default 10 seconds)', async (timeoutMs) => {
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    const adapter = new HttpWorkerReviewCompletionAdapter({ token, endpoint, timeoutMs, fetchImplementation });
    let settled = false;
    const failure = expectRedacted(adapter.reportReviewResult(event())).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync((timeoutMs ?? 10_000) - 1);
    expect(settled).toBe(false);
    expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('cancels a late response from a fetch that ignored the deadline without reading it', async () => {
    let finish!: (response: Response) => void;
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const adapter = new HttpWorkerReviewCompletionAdapter({ token, endpoint, timeoutMs: 250, fetchImplementation });
    const failure = expectRedacted(adapter.reportReviewResult(event()));
    await vi.advanceTimersByTimeAsync(250);
    await failure;
    const wire = streamingResponse([Buffer.from(JSON.stringify(receipt()))], false);
    finish(wire.response);
    await Promise.resolve();
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.pull).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('uses one total deadline for fetch plus an unfinished receipt body', async () => {
    const wire = streamingResponse([Buffer.from(JSON.stringify(receipt()))], false);
    let finish!: (response: Response) => void;
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => { finish = resolve; }));
    const adapter = new HttpWorkerReviewCompletionAdapter({ token, endpoint, timeoutMs: 250, fetchImplementation });
    let settled = false;
    const failure = expectRedacted(adapter.reportReviewResult(event())).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(200);
    finish(wire.response);
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(wire.pull).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(wire.cancel).toHaveBeenCalledOnce();
    expect(wire.response.body?.locked).toBe(false);
    expect(fetchImplementation.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each(['hang', 'reject', 'throw'])('does not wait for a body cancellation that may %s', async (behavior) => {
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const cancel = vi.fn((): Promise<void> => {
      if (behavior === 'throw') throw new Error(diagnostic);
      return behavior === 'hang' ? new Promise(() => {}) : Promise.reject(new Error(diagnostic));
    });
    const releaseLock = vi.fn();
    const response = { status: 200, redirected: false, body: { getReader: () => ({ read, cancel, releaseLock }) } } as unknown as Response;
    const f = fixture(response, 250);
    const failure = expectRedacted(f.adapter.reportReviewResult(event()));
    await vi.advanceTimersByTimeAsync(250);
    await failure;
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(f.fetchImplementation).toHaveBeenCalledOnce();
  });

  it('redacts body-read errors and still cancels/releases the reader', async () => {
    const read = vi.fn(async () => { throw new Error(`${token} ${diagnostic}`); });
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const response = { status: 200, redirected: false, body: { getReader: () => ({ read, cancel, releaseLock }) } } as unknown as Response;
    await expectRedacted(fixture(response).adapter.reportReviewResult(event()));
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
