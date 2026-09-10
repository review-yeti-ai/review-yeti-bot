import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { workerReviewCompletionSchema, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';

function app(ready = true) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => ready),
    allowAppGate: false,
  });
}

describe('admission-only Action dispatch server', () => {
  it('exposes health and database-backed readiness only', async () => {
    expect((await request(app()).get('/health')).body).toEqual(expect.objectContaining({
      status: 'ok',
      service: 'review-yeti-action-dispatch',
    }));
    expect((await request(app(true)).get('/ready')).status).toBe(200);
    expect((await request(app(false)).get('/ready')).status).toBe(503);
  });

  it('fails readiness closed when the database probe rejects', async () => {
    const rejected = createActionDispatchApp({
      verifier: { verify: vi.fn() } as any,
      admission: { admit: vi.fn() } as any,
      resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => { throw new Error('database unavailable'); }),
      allowAppGate: false,
    });

    const response = await request(rejected).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready', databaseReady: false });
  });

  it('does not mount webhook, dashboard, provider, metrics, or generic API routes', async () => {
    for (const route of ['/webhook', '/api/webhook/github', '/api/dashboard', '/api/router/providers', '/metrics']) {
      expect((await request(app()).post(route).send({})).status, route).toBe(404);
    }
  });

  it('mounts only the authenticated Action admission route under /api/dispatch', async () => {
    expect((await request(app()).post('/api/dispatch/action').send({})).status).toBe(401);
    expect((await request(app()).post('/api/dispatch/other').send({})).status).toBe(404);
  });
});

const COMPLETION_ENDPOINT = '/api/dispatch/completion';
const TOKEN = 'ghs_fake-server-body-limit-token';
const PRIVATE_DETAIL = 'private-payload-must-not-be-reflected';

function completionPayload(): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', runId: `run_${'a'.repeat(32)}`,
    repositoryId: 123, owner: 'calltelemetry', repo: 'example', prNumber: 42,
    headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
    policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt: 2,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T12:00:00.000Z',
      coverageComplete: true, quorumSatisfied: true,
      personas: [{ id: 'security', decision: 'FINDINGS', findings: [] }],
    },
  };
}

function sizedCompletion(bytes: number, multibyte = false): string {
  const payload = completionPayload();
  const findings = payload.result.personas[0].findings;
  // Many independently bounded findings make the outer-document boundary
  // reachable without first violating any individual string/array constraint.
  for (let i = 0; i < 70; i += 1) {
    findings.push({ severity: 'P2', path: 'src/example.ts', line: i + 1,
      title: 'Validate input', body: 'x' });
  }
  let remaining = bytes - Buffer.byteLength(JSON.stringify(payload), 'utf8');
  for (const finding of findings) {
    const addedBytes = Math.min(15_999, remaining);
    finding.body += multibyte
      ? '🦊'.repeat(Math.floor(addedBytes / 4)) + 'x'.repeat(addedBytes % 4)
      : 'x'.repeat(addedBytes);
    remaining -= addedBytes;
  }
  expect(remaining).toBe(0);
  expect(workerReviewCompletionSchema.safeParse(payload).success).toBe(true);
  const serialized = JSON.stringify(payload);
  expect(Buffer.byteLength(serialized, 'utf8')).toBe(bytes);
  return serialized;
}

function bodyLimitFixture() {
  const now = Date.parse('2026-09-09T12:00:01.000Z');
  const verify = vi.fn().mockResolvedValue({ workerTokenDigest: 'f'.repeat(64) });
  const recordWorkerResult = vi.fn().mockResolvedValue('recorded');
  const resolve = vi.fn();
  const actionVerify = vi.fn().mockResolvedValue({
    repository: 'calltelemetry/example', repository_id: '123', repository_owner_id: '99',
    run_id: '98765', run_attempt: '2', event_name: 'workflow_dispatch',
  });
  const admit = vi.fn().mockResolvedValue({ status: 'accepted', run: { runId: completionPayload().runId } });
  const instance = createActionDispatchApp({
    verifier: { verify: actionVerify }, admission: { admit },
    resolveInstallationId: vi.fn(async () => 456), databaseReady: vi.fn(async () => true), now: () => now,
    authoritativeWorkerCompletion: { verifier: { verify }, repository: { recordWorkerResult }, resolve },
  });
  return { instance, verify, recordWorkerResult, resolve, actionVerify, admit, now };
}

describe('dispatch server JSON body boundaries', () => {
  it.each([65_537, 999_999, 1_000_000])('accepts a strict completion containing exactly %i UTF-8 bytes', async (bytes) => {
    const f = bodyLimitFixture();
    const serialized = sizedCompletion(bytes);
    const response = await request(f.instance).post(COMPLETION_ENDPOINT)
      .auth(TOKEN, { type: 'bearer' }).set('Content-Type', 'application/json').send(serialized);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'WorkerReviewCompletionAccepted.v1', runId: completionPayload().runId, status: 'recorded' });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith(TOKEN, JSON.parse(serialized));
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('accepts a multibyte completion at exactly 1,000,000 bytes', async () => {
    const f = bodyLimitFixture();
    const serialized = sizedCompletion(1_000_000, true);
    expect(serialized.length).toBeLessThan(1_000_000);
    const response = await request(f.instance).post(COMPLETION_ENDPOINT)
      .auth(TOKEN, { type: 'bearer' }).set('Content-Type', 'application/json').send(serialized);
    expect(response.status).toBe(200);
    expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rejects 1,000,001 completion bytes before authentication (multibyte=%s)', async (multibyte) => {
    const f = bodyLimitFixture();
    const serialized = sizedCompletion(1_000_001, multibyte);
    if (multibyte) expect(serialized.length).toBeLessThan(1_000_000);
    const response = await request(f.instance).post(COMPLETION_ENDPOINT)
      .auth(TOKEN, { type: 'bearer' }).set('Content-Type', 'application/json').send(serialized);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Request body exceeds its permitted size' });
    expect(response.text).not.toContain(TOKEN);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each([999_999, 1_000_001])('enforces the completion limit while streaming %i bytes without Content-Length', async (bytes) => {
    const f = bodyLimitFixture();
    const serialized = sizedCompletion(bytes);
    const pending = request(f.instance).post(COMPLETION_ENDPOINT)
      .auth(TOKEN, { type: 'bearer' }).set('Content-Type', 'application/json');
    // write(), rather than send(), exercises chunked transfer and the running
    // byte count instead of rejection from the Content-Length header alone.
    pending.write(serialized.slice(0, 60_000));
    pending.write(serialized.slice(60_000));
    const response = await pending;
    expect(response.status).toBe(bytes < 1_000_000 ? 200 : 413);
    if (bytes < 1_000_000) {
      expect(f.recordWorkerResult).toHaveBeenCalledTimes(1);
    } else {
      expect(response.body).toEqual({ error: 'Request body exceeds its permitted size' });
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.recordWorkerResult).not.toHaveBeenCalled();
    }
  });

  it.each(['/api/dispatch/action', COMPLETION_ENDPOINT])('redacts invalid JSON on %s', async (endpoint) => {
    const f = bodyLimitFixture();
    const response = await request(f.instance).post(endpoint).auth(TOKEN, { type: 'bearer' })
      .set('Content-Type', 'application/json').send(`{"version":"${PRIVATE_DETAIL}",`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid JSON body' });
    expect(response.text).not.toContain(PRIVATE_DETAIL);
    expect(response.text).not.toContain(TOKEN);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.actionVerify).not.toHaveBeenCalled();
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it.each(['null', '42', 'true', '"private-scalar"'])('rejects the JSON scalar %s before reaching a handler', async (raw) => {
    const f = bodyLimitFixture();
    const response = await request(f.instance).post(COMPLETION_ENDPOINT).auth(TOKEN, { type: 'bearer' })
      .set('Content-Type', 'application/json').send(raw);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid JSON body' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
  });

  it.each([65_536, 65_537])('retains the Action route boundary for a valid %i-byte request', async (bytes) => {
    const f = bodyLimitFixture();
    const payload = {
      version: 'ActionDispatch.v1', deliveryId: `actions:98765:2:123:42:${'b'.repeat(40)}`,
      repositoryId: 123, owner: 'calltelemetry', repo: 'example', prNumber: 42,
      headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), actionSha: 'd'.repeat(40),
      publishMode: 'disabled', requestedAt: new Date(f.now).toISOString(),
      caller: { runId: '98765', runAttempt: 2, eventName: 'workflow_dispatch' },
    };
    const serialized = JSON.stringify(payload);
    const padded = serialized + ' '.repeat(bytes - Buffer.byteLength(serialized));
    expect(Buffer.byteLength(padded)).toBe(bytes);
    const response = await request(f.instance).post('/api/dispatch/action')
      .auth(TOKEN, { type: 'bearer' }).set('Content-Type', 'application/json').send(padded);
    expect(response.status).toBe(bytes === 65_536 ? 202 : 413);
    if (bytes === 65_536) {
      expect(response.body).toEqual({ version: 'ActionDispatchAccepted.v1', status: 'accepted', runId: completionPayload().runId });
      expect(f.admit).toHaveBeenCalledTimes(1);
    } else {
      expect(response.body).toEqual({ error: 'Request body exceeds its permitted size' });
      expect(f.actionVerify).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
    }
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
  });

  it('redacts an oversized malformed completion before parsing its private content', async () => {
    const f = bodyLimitFixture();
    const response = await request(f.instance).post(COMPLETION_ENDPOINT).auth(TOKEN, { type: 'bearer' })
      .set('Content-Type', 'application/json').send(`{"${PRIVATE_DETAIL}":"${'x'.repeat(1_000_000)}`);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'Request body exceeds its permitted size' });
    expect(response.text).not.toContain(PRIVATE_DETAIL);
    expect(response.text).not.toContain(TOKEN);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.recordWorkerResult).not.toHaveBeenCalled();
  });
});
