import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { createGitHubWebhookAdmissionHandler } from '../../src/review/githubWebhookAdmission';
import { createMergeGroupGate, MergeGroupGateInProgressError } from '../../src/review/mergeGroupGate';

const SECRET = 'webhook-secret-with-at-least-thirty-two-bytes';
const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened', number: 42,
    installation: { id: 456 },
    repository: {
      id: 614653796, name: 'dashboard', full_name: 'calltelemetry/dashboard',
      owner: { id: 57884877, login: 'calltelemetry' },
    },
    pull_request: {
      number: 42, state: 'open', draft: false,
      head: { sha: HEAD },
      base: { sha: BASE, repo: { full_name: 'calltelemetry/dashboard' } },
    },
    ...overrides,
  };
}

function fixture(admissionEnabled = true) {
  const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: `run_${'1'.repeat(32)}` } }));
  const onEvent = createGitHubWebhookAdmissionHandler({
    config: {
      secret: SECRET, admissionEnabled,
      repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']),
    },
    admission: { admit } as any,
    now: () => NOW,
  });
  const instance = createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(), databaseReady: vi.fn(async () => true),
    allowAppGate: true, githubWebhook: { secret: SECRET, onEvent },
  });
  return { instance, admit };
}

function signed(body: unknown, delivery = 'delivery-123') {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
  return { raw, signature, delivery };
}

describe('native GitHub App webhook admission', () => {
  it.each(['opened', 'synchronize', 'reopened', 'ready_for_review'])('admits %s directly as the App gate', async (action) => {
    const f = fixture();
    const body = payload({ action });
    const auth = signed(body, `delivery-${action}`);
    const response = await request(f.instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', auth.delivery)
      .set('X-Hub-Signature-256', auth.signature)
      .send(auth.raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'accepted', deliveryId: auth.delivery, prNumber: 42, headSha: HEAD });
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deliveryId: `github-webhook:${auth.delivery}`,
      eventName: 'pull_request', repositoryId: 614653796, installationId: 456,
      publicationMode: 'app-gate', receivedAt: NOW,
      identity: expect.objectContaining({ owner: 'calltelemetry', repo: 'dashboard', prNumber: 42, headSha: HEAD, baseSha: BASE }),
    }));
  });

  it('rejects an invalid signature before admission', async () => {
    const f = fixture();
    const response = await request(f.instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', 'delivery-invalid')
      .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`)
      .send(JSON.stringify(payload()));
    expect(response.status).toBe(401);
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('keeps the route live but ignores admissions while the cutover flag is paused', async () => {
    const f = fixture(false);
    const body = payload();
    const auth = signed(body);
    const response = await request(f.instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', auth.delivery)
      .set('X-Hub-Signature-256', auth.signature)
      .send(auth.raw);
    expect(response.body).toEqual({ status: 'ignored', reason: 'admission_paused' });
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('routes a signed merge_group delivery to the one official App gate', async () => {
    const mergeGroupGate = vi.fn(async () => ({ checkId: 9001, conclusion: 'success' as const, constituents: 2 }));
    const admit = vi.fn();
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: { secret: SECRET, admissionEnabled: true,
        repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) },
      admission: { admit } as any, mergeGroupGate,
    });
    const instance = createActionDispatchApp({
      verifier: { verify: vi.fn() } as any, admission: { admit: vi.fn() } as any,
      resolveInstallationId: vi.fn(), databaseReady: vi.fn(async () => true), allowAppGate: true,
      githubWebhook: { secret: SECRET, onEvent },
    });
    const body = { action: 'checks_requested', merge_group: { head_sha: HEAD } };
    const auth = signed(body, 'merge-delivery');
    const response = await request(instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'merge_group')
      .set('X-GitHub-Delivery', auth.delivery)
      .set('X-Hub-Signature-256', auth.signature)
      .send(auth.raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'success', checkId: 9001, constituents: 2 });
    expect(mergeGroupGate).toHaveBeenCalledExactlyOnceWith(body);
    expect(admit).not.toHaveBeenCalled();
  });

  it('rejects a malformed signed merge_group payload instead of treating it as unenrolled', async () => {
    const repository = {
      claim: vi.fn(), complete: vi.fn(), release: vi.fn(),
    };
    const config = { secret: SECRET, admissionEnabled: true,
      repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) };
    const mergeGroupGate = createMergeGroupGate({
      config, repository: repository as any, tokenFor: vi.fn(async () => 'ghs_test'),
    });
    const onEvent = createGitHubWebhookAdmissionHandler({
      config, admission: { admit: vi.fn() } as any, mergeGroupGate,
    });
    const body = {
      action: 'checks_requested', installation: { id: 123 }, repository: payload().repository,
      merge_group: {
        head_sha: 'not-a-sha', base_sha: BASE,
        head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef0', base_ref: 'refs/heads/main',
      },
    };
    await expect(onEvent({
      eventName: 'merge_group', deliveryId: 'malformed',
      rawBody: Buffer.from(JSON.stringify(body)), body,
    })).rejects.toThrow();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate merge_group delivery while its durable lease is active', async () => {
    const config = { secret: SECRET, admissionEnabled: true,
      repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) };
    const onEvent = createGitHubWebhookAdmissionHandler({
      config, admission: { admit: vi.fn() } as any,
      mergeGroupGate: vi.fn(async () => { throw new MergeGroupGateInProgressError(); }),
    });
    await expect(onEvent({
      eventName: 'merge_group', deliveryId: 'duplicate', rawBody: Buffer.from('{}'), body: {},
    })).resolves.toEqual({ status: 'accepted', reason: 'merge_group_in_progress' });
  });

  it.each([
    payload({ repository: { id: 999, name: 'dashboard', full_name: 'calltelemetry/dashboard', owner: { id: 57884877, login: 'calltelemetry' } } }),
    payload({ pull_request: { number: 42, state: 'open', draft: false, head: { sha: HEAD }, base: { sha: BASE, repo: { full_name: 'other/dashboard' } } } }),
  ])('quietly ignores a mismatched repository identity', async (body) => {
    const f = fixture();
    const auth = signed(body);
    const response = await request(f.instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', auth.delivery)
      .set('X-Hub-Signature-256', auth.signature)
      .send(auth.raw);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ignored', reason: 'not_enrolled' });
    expect(f.admit).not.toHaveBeenCalled();
  });

  it.each([
    payload({ action: 'closed' }),
    payload({ pull_request: { number: 42, state: 'open', draft: true, head: { sha: HEAD }, base: { sha: BASE, repo: { full_name: 'calltelemetry/dashboard' } } } }),
  ])('ignores unsupported PR states without admitting a review', async (body) => {
    const f = fixture();
    const auth = signed(body);
    const response = await request(f.instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-GitHub-Delivery', auth.delivery)
      .set('X-Hub-Signature-256', auth.signature)
      .send(auth.raw);
    expect(response.body).toEqual({ status: 'ignored', reason: 'unsupported_pull_request_state' });
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('keeps authoritative enrollment paused without admitting or resolving policy', async () => {
    const admit = vi.fn();
    const resolve = vi.fn();
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: { secret: SECRET, admissionEnabled: true,
        repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) },
      admission: { admit } as any,
      authoritativePublishing: {
        expectedAppId: 4385771, acceptNewRequests: false, repositoryIds: [614653796], resolver: { resolve },
      } as any,
    });
    const event = { eventName: 'pull_request', deliveryId: 'paused',
      rawBody: Buffer.from(JSON.stringify(payload())), body: payload() };
    await expect(onEvent(event)).resolves.toEqual({ status: 'ignored', reason: 'authoritative_admission_paused' });
    expect(resolve).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('binds an enrolled authoritative resolution and prepared policy into admission', async () => {
    const effectivePolicyDigest = 'd'.repeat(64);
    const prepared = { policy: { effectivePolicyDigest }, marker: 'prepared' };
    const identity = { owner: 'calltelemetry', repo: 'dashboard', prNumber: 42,
      headSha: HEAD, baseSha: BASE, snapshotDigest: 'e'.repeat(64), configDigest: 'f'.repeat(64) };
    const resolve = vi.fn(async () => ({ identity, prepared }));
    const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: `run_${'1'.repeat(32)}` } }));
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: { secret: SECRET, admissionEnabled: true,
        repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) },
      admission: { admit } as any,
      authoritativePublishing: {
        expectedAppId: 4385771, acceptNewRequests: true, repositoryIds: [614653796], resolver: { resolve },
      } as any,
    });
    const event = { eventName: 'pull_request', deliveryId: 'authoritative',
      rawBody: Buffer.from(JSON.stringify(payload())), body: payload() };
    await expect(onEvent(event)).resolves.toEqual({ status: 'accepted', deliveryId: 'authoritative', prNumber: 42, headSha: HEAD });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      repositoryId: 614653796, owner: 'calltelemetry', repo: 'dashboard', prNumber: 42, headSha: HEAD, baseSha: BASE,
    });
    expect(admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      identity, effectivePolicyDigest, authoritativeGate: { expectedAppId: 4385771, prepared },
    }));
  });

  it('uses legacy identity when authoritative publishing does not enroll the repository', async () => {
    const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: `run_${'1'.repeat(32)}` } }));
    const resolve = vi.fn();
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: { secret: SECRET, admissionEnabled: true,
        repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']) },
      admission: { admit } as any,
      authoritativePublishing: {
        expectedAppId: 4385771, acceptNewRequests: true, repositoryIds: [999], resolver: { resolve },
      } as any,
    });
    const event = { eventName: 'pull_request', deliveryId: 'legacy',
      rawBody: Buffer.from(JSON.stringify(payload())), body: payload() };
    await onEvent(event);
    expect(resolve).not.toHaveBeenCalled();
    const admitted = (admit as any).mock.calls[0][0];
    expect(admitted).not.toHaveProperty('authoritativeGate');
    expect(admitted).not.toHaveProperty('effectivePolicyDigest');
  });
});
