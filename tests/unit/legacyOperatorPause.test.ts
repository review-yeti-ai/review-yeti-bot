import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApp } from '../../src/app';
import { createOnboardingRouter } from '../../src/api/onboarding';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { GitHubActionsOidcVerifier } from '../../src/auth/githubActionsOidc';
import { expectedActionDeliveryId } from '../../src/review/actionDispatch';

const webhookSecret = 'legacy-pause-webhook-secret-for-tests-32-bytes';
const workflowSha = 'a'.repeat(40);
let deliverySequence = 0;
let publishedEvents: MockInstance<LiveStreamBus['publishEvent']>;

function stubPauseIdentityEnv(options: { identities?: string; privateKey?: string } = {}): void {
  vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');
  vi.stubEnv('GITHUB_APP_ID', '4385771');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', options.privateKey ?? '');
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', webhookSecret);
  vi.stubEnv('WEBHOOK_SECRET', webhookSecret);
  vi.stubEnv('ACTION_DISPATCH_ALLOW_APP_GATE', 'true');
  vi.stubEnv('ACTION_DISPATCH_REPOSITORY_IDS', '1234');
  vi.stubEnv('ACTION_DISPATCH_OWNER_IDS', '5678');
  vi.stubEnv('ACTION_DISPATCH_WORKFLOW_REFS', 'exampleorg/review/.github/workflows/review.yml@refs/heads/main');
  vi.stubEnv('ACTION_DISPATCH_WORKFLOW_SHAS', workflowSha);
  vi.stubEnv('AUTHORITATIVE_REVIEW_ENABLED', 'true');
  vi.stubEnv('AUTHORITATIVE_REVIEW_APP_ID', '4385771');
  vi.stubEnv('AUTHORITATIVE_REVIEW_REPOSITORY_IDS', '1234');
  vi.stubEnv('AUTHORITATIVE_REVIEW_REPOSITORY_IDENTITIES', options.identities
    ?? JSON.stringify([{ repositoryId: 1234, owner: 'exampleorg', repo: 'service' }]));
  vi.stubEnv('GITHUB_APP_WEBHOOK_ENABLED', 'true');
  vi.stubEnv('GITHUB_APP_WEBHOOK_ADMISSION_ENABLED', 'false');
  vi.stubEnv('GITHUB_APP_WEBHOOK_REPOSITORY_IDS', '1234');
  vi.stubEnv('GITHUB_APP_WEBHOOK_OWNER_IDS', '5678');
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'REVIEW_MODEL', 'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL', 'BIFROST_BASE_URL']) vi.stubEnv(name, '');
}

function openedPullRequest(repositoryId = 1234): Record<string, unknown> {
  const fullName = repositoryId === 1234 ? 'exampleorg/service' : 'otherorg/service';
  const [owner, repo] = fullName.split('/');
  return {
    action: 'opened',
    installation: { id: 9012 },
    repository: { id: repositoryId, name: repo, full_name: fullName,
      owner: { id: 5678, login: owner } },
    sender: { login: 'contributor' },
    number: 42,
    pull_request: { number: 42, state: 'open', draft: false, title: 'A test PR', body: '',
      labels: [], head: { sha: 'b'.repeat(40), repo: { full_name: fullName } },
      base: { sha: 'c'.repeat(40), ref: 'main', repo: { full_name: fullName } } },
  };
}

function requestedReviewComment(): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 9012 },
    repository: { id: 1234, name: 'service', full_name: 'exampleorg/service',
      owner: { id: 5678, login: 'exampleorg' } },
    sender: { login: 'contributor' },
    issue: { number: 42, state: 'open', pull_request: { url: 'https://api.github.com/repos/exampleorg/service/pulls/42' } },
    comment: { body: '/review' },
  };
}

function actionDispatch(owner = 'exampleorg', repo = 'service') {
  const request = {
    version: 'ActionDispatch.v1',
    deliveryId: '',
    repositoryId: 1234,
    owner,
    repo,
    prNumber: 42,
    headSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
    actionSha: workflowSha,
    publishMode: 'app-gate',
    requestedAt: new Date().toISOString(),
    caller: {
      runId: '101', runAttempt: 1, eventName: 'pull_request',
      workflowRef: 'exampleorg/review/.github/workflows/review.yml@refs/heads/main',
      workflowSha,
    },
  };
  request.deliveryId = expectedActionDeliveryId(request as any);
  return request;
}

function actionClaims(owner = 'exampleorg', repo = 'service') {
  return {
    repository: `${owner}/${repo}`, repository_id: '1234', repository_owner_id: '5678',
    run_id: '101', run_attempt: '1', event_name: 'pull_request',
    workflow_ref: 'exampleorg/review/.github/workflows/review.yml@refs/heads/main',
    workflow_sha: workflowSha,
  };
}

function signedWebhook(body: Record<string, unknown>, eventName = 'pull_request') {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`;
  const session = authService.createGitHubSession({
    id: 'pause-test-admin', username: 'pause-test-admin', role: 'admin', provider: 'github',
  });
  return request(createApp()).post('/api/webhooks/github')
    .set('Authorization', `Bearer ${session.token}`)
    .set('Content-Type', 'application/json')
    .set('x-github-event', eventName)
    .set('x-github-delivery', `delivery-legacy-pause-${++deliverySequence}`)
    .set('x-hub-signature-256', signature)
    .send(raw);
}

describe('legacy app behavior during operator pause', () => {
  beforeEach(() => {
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'false');
    authService.reset();
    dashboardStore.reset();
    LiveStreamBus.getInstance().clearHistory();
    publishedEvents = vi.spyOn(LiveStreamBus.getInstance(), 'publishEvent');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps the legacy readiness endpoint available from inbound identity config without an outbound model key', async () => {
    stubPauseIdentityEnv({ privateKey: '' });

    const response = await request(createApp()).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', readinessContract: 'pause-safe',
      operatorPauseEnabled: true, pauseIdentityConfigured: true, databaseReady: null });
  });

  it('returns candidate-less logical SHIP for a signed enrolled PR without queuing the legacy pipeline', async () => {
    stubPauseIdentityEnv();

    const response = await signedWebhook(openedPullRequest());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'unavailable', reason: 'operator_global_passthrough',
      reviewStarted: false, candidateState: 'unavailable', verdict: 'SHIP', expectedLanes: 0,
      completedLanes: 0, publicationId: null, auditDigest: null, publicationState: 'unavailable',
      publicationReceiptAvailable: null, reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      repositoryId: 1234, repository: 'exampleorg/service', prNumber: 42, headSha: null, baseSha: null });
    expect(response.body).not.toHaveProperty('runId');
    expect(response.body).not.toHaveProperty('attemptId');
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('does not grant the paused SHIP projection to a signed but unenrolled repository', async () => {
    stubPauseIdentityEnv();

    const response = await signedWebhook(openedPullRequest(9999));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ignored', reason: 'not_enrolled' });
    expect(response.body.verdict).toBeUndefined();
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('returns paused SHIP for a signed review comment without resolving a current candidate', async () => {
    stubPauseIdentityEnv();

    const response = await signedWebhook(requestedReviewComment(), 'issue_comment');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'unavailable', reason: 'operator_global_passthrough',
      reviewStarted: false, candidateState: 'unavailable', verdict: 'SHIP', expectedLanes: 0,
      completedLanes: 0, publicationId: null, publicationState: 'unavailable', mergeEligible: false,
      repositoryId: 1234, repository: 'exampleorg/service', prNumber: 42, headSha: null, baseSha: null });
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('rejects a signed repository name that conflicts with its configured numeric identity', async () => {
    stubPauseIdentityEnv({ identities: JSON.stringify([{ repositoryId: 1234, owner: 'otherorg', repo: 'renamed' }]) });

    const response = await signedWebhook(openedPullRequest());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ignored', reason: 'not_enrolled' });
    expect(response.body.verdict).toBeUndefined();
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('does not report pause-safe readiness or fall back to the legacy pipeline without static webhook identity', async () => {
    stubPauseIdentityEnv();
    vi.stubEnv('GITHUB_APP_WEBHOOK_ENABLED', 'false');

    const ready = await request(createApp()).get('/ready');
    const webhook = await signedWebhook(openedPullRequest());

    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ status: 'not_ready', readinessContract: 'pause-safe',
      operatorPauseEnabled: true, pauseIdentityConfigured: false });
    expect(webhook.status).toBe(500);
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('keeps direct on-demand pause responses behind caller auth and static repository identity', async () => {
    stubPauseIdentityEnv();
    dashboardStore.updateRepository('exampleorg', 'service', { automationEnabled: true, id: '1234' } as any);
    const session = authService.createGitHubSession({
      id: 'pause-test-admin', username: 'pause-test-admin', role: 'admin', provider: 'github',
    });
    const route = '/api/github/repos/exampleorg/service/pulls/42/review';

    expect((await request(createApp()).post(route).send({})).status).toBe(401);
    const response = await request(createApp()).post(route)
      .set('Authorization', `Bearer ${session.token}`).send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, status: 'unavailable',
      reason: 'operator_global_passthrough', candidateState: 'unavailable', verdict: 'SHIP',
      expectedLanes: 0, completedLanes: 0, publicationId: null, auditDigest: null,
      reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      repositoryId: 1234, repository: 'exampleorg/service', prNumber: 42, headSha: null, baseSha: null });
    expect(response.body).not.toHaveProperty('jobId');
    expect(response.body).not.toHaveProperty('runId');
    expect(response.body).not.toHaveProperty('attemptId');
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);

    vi.stubEnv('AUTHORITATIVE_REVIEW_REPOSITORY_IDENTITIES', '');
    const unmapped = await request(createApp()).post(route)
      .set('Authorization', `Bearer ${session.token}`).send({});
    expect(unmapped.status).toBe(403);
    expect(unmapped.body).toMatchObject({ success: false, reason: 'not_enrolled' });
  });

  it('does not let force bypass a disabled repository automation gate during pause', async () => {
    stubPauseIdentityEnv();
    dashboardStore.updateRepository('exampleorg', 'service', { automationEnabled: false, id: '1234' } as any);
    const session = authService.createGitHubSession({
      id: 'pause-test-admin', username: 'pause-test-admin', role: 'admin', provider: 'github',
    });

    const response = await request(createApp()).post('/api/github/repos/exampleorg/service/pulls/42/review')
      .set('Authorization', `Bearer ${session.token}`).send({ force: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Repository review automation is disabled');
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);
  });

  it('preserves OIDC request checks and returns logical SHIP for full-app Action dispatch during pause', async () => {
    stubPauseIdentityEnv();
    vi.stubEnv('ACTION_DISPATCH_ENABLED', 'true');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('POSTGRES_URL', '');
    const verify = vi.spyOn(GitHubActionsOidcVerifier.prototype, 'verify')
      .mockResolvedValue(actionClaims() as any);
    const app = createApp();
    const body = actionDispatch();

    expect((await request(app).post('/api/dispatch/action').send(body)).status).toBe(401);
    const response = await request(app).post('/api/dispatch/action')
      .set('Authorization', 'Bearer pause-test-oidc-token').send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: 'ActionDispatchPassthrough.v1',
      status: 'passthrough', reason: 'operator_global_passthrough', reviewStarted: false,
      candidateState: 'unavailable', verdict: 'SHIP', expectedLanes: 0, completedLanes: 0,
      publicationId: null, auditDigest: null, reviewCheckId: null, gateCheckId: null,
      publicationState: 'unavailable', publicationReceiptAvailable: null, mergeEligible: false,
      repositoryId: 1234, owner: 'exampleorg', repo: 'service', prNumber: 42,
      headSha: null, baseSha: null });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(publishedEvents.mock.calls.map(([event]) => event).filter((event: any) => event.type === 'job:queued')).toEqual([]);

    const mismatched = actionDispatch('exampleorg', 'other-service');
    verify.mockResolvedValueOnce(actionClaims('exampleorg', 'other-service') as any);
    const rejected = await request(app).post('/api/dispatch/action')
      .set('Authorization', 'Bearer pause-test-oidc-token').send(mismatched);
    expect(rejected.status).toBe(403);
  });

  it('blocks the onboarding provider diagnostic before reading providers or calling the panel during pause', async () => {
    stubPauseIdentityEnv();
    const app = express();
    app.use(express.json());
    app.use('/api/onboarding', createOnboardingRouter({ operatorPauseEnabled: true }));
    const getProviders = vi.spyOn(dashboardStore, 'getProviderConfigs');

    const response = await request(app).post('/api/onboarding/diagnostic').send({ providerIds: ['openai'] });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ success: false, status: 'unavailable',
      reason: 'operator_global_passthrough' });
    expect(getProviders).not.toHaveBeenCalled();
  });
});
