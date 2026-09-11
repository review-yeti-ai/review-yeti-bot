import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';
import type { ReviewCiCaller } from '../../src/auth/reviewCiOidc';
import { createReviewCiLanePlan } from '../../src/review/reviewCi';

const id = '00000000-0000-4000-8000-000000000001';
const repository = { repositoryId: 123, ownerId: 99, owner: 'example', repo: 'pilot',
  relay: { workflowId: 11, workflowPath: '.github/workflows/relay.yml', workflowRef: 'refs/heads/main', workflowSha: 'a'.repeat(40) },
  validation: { workflowId: 12, workflowPath: '.github/workflows/validation.yml', workflowRef: 'refs/heads/main', workflowSha: 'b'.repeat(40) },
  lanePlan: createReviewCiLanePlan(['unit'], ['Trusted preflight', 'Unit tests']) };
const event = { schema_version: 'review-yeti-ci-request.v1', repository_id: 123, repository: 'example/pilot', pr_number: 42,
  base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), attempt_id: `run_${'1'.repeat(32)}-g0-e1`,
  policy_digest: 'f'.repeat(64), validation_request_id: id };
function fixture(enabled = true) {
  const verify = vi.fn(async (_token: string, role: ReviewCiCaller['role']): Promise<ReviewCiCaller> => ({
    role, repository, runId: 100, runAttempt: 1, claims: { repository: 'example/pilot', repository_id: '123',
      repository_owner_id: '99', run_id: '100', run_attempt: '1', event_name: 'workflow_dispatch', workflow_sha: 'b'.repeat(40) },
  }));
  const accepted = { version: 'ReviewCiClaim.v1' as const, allowed: true as const, requestId: id, epoch: 1,
    candidateSha: 'c'.repeat(40), headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), lanes: ['unit'], lanePlanDigest: repository.lanePlan.digest };
  const service = { wake: vi.fn().mockResolvedValue('recorded'), claim: vi.fn().mockResolvedValue(accepted) };
  const app = createActionDispatchApp({ verifier: { verify: vi.fn() }, admission: { admit: vi.fn() },
    databaseReady: async () => true, resolveInstallationId: vi.fn(),
    ...(enabled ? { ci: { verifier: { verify }, service } } : {}) });
  return { app, verify, service, accepted };
}

describe('Review CI trusted HTTP boundary', () => {
  it('does not mount either CI route unless explicitly enabled', async () => {
    const f = fixture(false);
    expect((await request(f.app).post('/api/dispatch/ci/event').send(event)).status).toBe(404);
    expect((await request(f.app).post('/api/dispatch/ci/claim').send({ requestId: id, epoch: 1 })).status).toBe(404);
    expect(f.verify).not.toHaveBeenCalled();
  });
  it.each([event, { schema_version: 'review-yeti-ci-wake.v1', validation_request_id: id }])('accepts a signed relay only as a request identity hint', async (payload) => {
    const f = fixture();
    const response = await request(f.app).post('/api/dispatch/ci/event').set('Authorization', 'Bearer synthetic-oidc').send(payload);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ version: 'ReviewCiWake.v1', status: 'recorded' });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith('synthetic-oidc', 'relay');
    expect(f.service.wake).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ repository }));
    expect(f.service.claim).not.toHaveBeenCalled();
  });
  it.each([{ ...event, verdict: 'SHIP' }, { ...event, policy_digest: `sha256:${'f'.repeat(64)}` },
    { ...event, validation_request_id: 'not-a-uuid' }, { ...event, pr_number: 0 }, { ...event, head_sha: 'main' }])('rejects malformed or authority-bearing event fields before authentication', async (payload) => {
    const f = fixture();
    expect((await request(f.app).post('/api/dispatch/ci/event').set('Authorization', 'Bearer synthetic-oidc').send(payload)).status).toBe(400);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.service.wake).not.toHaveBeenCalled();
  });
  it('rejects repository substitution after signature verification', async () => {
    const f = fixture();
    const response = await request(f.app).post('/api/dispatch/ci/event').set('Authorization', 'Bearer synthetic-oidc')
      .send({ ...event, repository_id: 456, repository: 'example/other' });
    expect(response.status).toBe(403); expect(f.service.wake).not.toHaveBeenCalled();
  });
  it.each(['/event', '/claim'])('requires a bearer and redacts verifier errors on %s', async (path) => {
    const f = fixture(), payload = path === '/event' ? event : { requestId: id, epoch: 1 };
    expect((await request(f.app).post(`/api/dispatch/ci${path}`).send(payload)).status).toBe(401);
    f.verify.mockRejectedValueOnce(new Error('synthetic-private-token-detail'));
    const response = await request(f.app).post(`/api/dispatch/ci${path}`).set('Authorization', 'Bearer synthetic-oidc').send(payload);
    expect(response.status).toBe(403); expect(response.text).not.toContain('synthetic-private-token-detail');
    expect(f.service.wake).not.toHaveBeenCalled(); expect(f.service.claim).not.toHaveBeenCalled();
  });
  it('returns only the service-issued execution contract for a validation caller', async () => {
    const f = fixture();
    const response = await request(f.app).post('/api/dispatch/ci/claim').set('Authorization', 'Bearer synthetic-oidc').send({ requestId: id, epoch: 1 });
    expect(response.status).toBe(200); expect(response.body).toEqual(f.accepted);
    expect(f.verify).toHaveBeenCalledExactlyOnceWith('synthetic-oidc', 'validation');
    expect(f.service.claim).toHaveBeenCalledExactlyOnceWith(id, 1, expect.objectContaining({ runId: 100, runAttempt: 1 }));
  });
  it.each([{ requestId: id, epoch: 0 }, { requestId: id, epoch: 1.5 }, { requestId: id, epoch: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: id, epoch: 1, candidateSha: 'c'.repeat(40) }, { requestId: id, epoch: 1, runId: 999 }])('rejects caller-selected execution authority', async (payload) => {
    const f = fixture();
    expect((await request(f.app).post('/api/dispatch/ci/claim').set('Authorization', 'Bearer synthetic-oidc').send(payload)).status).toBe(400);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.service.claim).not.toHaveBeenCalled();
  });
  it('keeps stale claims distinct from transient service failure without leaking diagnostics', async () => {
    const f = fixture(); f.service.claim.mockResolvedValueOnce(null);
    expect((await request(f.app).post('/api/dispatch/ci/claim').set('Authorization', 'Bearer synthetic-oidc').send({ requestId: id, epoch: 1 })).status).toBe(409);
    f.service.claim.mockRejectedValueOnce(new Error('synthetic-private-database-detail'));
    const failed = await request(f.app).post('/api/dispatch/ci/claim').set('Authorization', 'Bearer synthetic-oidc').send({ requestId: id, epoch: 1 });
    expect(failed.status).toBe(503); expect(failed.text).not.toContain('synthetic-private-database-detail');
    f.service.wake.mockRejectedValueOnce(new Error('synthetic-private-database-detail'));
    const wake = await request(f.app).post('/api/dispatch/ci/event').set('Authorization', 'Bearer synthetic-oidc').send(event);
    expect(wake.status).toBe(503); expect(wake.text).not.toContain('synthetic-private-database-detail');
  });
  it('bounds request bodies and rejects invalid JSON using the actual application middleware', async () => {
    const f = fixture();
    expect((await request(f.app).post('/api/dispatch/ci/event').set('Content-Type', 'application/json').send('{')).status).toBe(400);
    const response = await request(f.app).post('/api/dispatch/ci/event').send({ ...event, padding: 'x'.repeat(70_000) });
    expect(response.status).toBe(413); expect(response.body).toEqual({ error: 'Request body exceeds its permitted size' });
    expect(f.verify).not.toHaveBeenCalled();
  });
});
