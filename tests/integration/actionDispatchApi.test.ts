import express from 'express';
import request from 'supertest';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter, createWorkerCompletionVerifier, type ActionDispatchRouterOptions } from '../../src/api/actionDispatchApi';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GitHubActionsOidcVerifier } from '../../src/auth/githubActionsOidc';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import type { AuthoritativePublishingResolution, RequestedReviewCandidate } from '../../src/review/authoritativePublishingResolver';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { actionDispatchDigestInput, type ActionDispatchRequest } from '../../src/review/actionDispatch';
import { sha256 } from '../../src/review/reviewCore';

const body = {
  version: 'ActionDispatch.v1',
  deliveryId: `actions:98765:2:123:42:${'b'.repeat(40)}`,
  repositoryId: 123,
  owner: 'calltelemetry',
  repo: 'cisco-cdr',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  actionSha: 'a'.repeat(40),
  publishMode: 'disabled',
  requestedAt: new Date().toISOString(),
  caller: {
    runId: '98765',
    runAttempt: 2,
    eventName: 'workflow_dispatch',
    workflowRef: 'calltelemetry/ct-review-actions/.github/workflows/review.yml@refs/heads/main',
    workflowSha: 'd'.repeat(40),
  },
};

const verified = {
  repository: 'calltelemetry/cisco-cdr',
  repository_id: '123',
  repository_owner_id: '99',
  run_id: '98765',
  run_attempt: '2',
  event_name: 'workflow_dispatch',
  job_workflow_ref: body.caller.workflowRef,
  job_workflow_sha: body.caller.workflowSha,
};

function app(overrides: Record<string, any> = {}) {
  const verifier = { verify: vi.fn(async () => verified), ...(overrides.verifier || {}) };
  const admission = { admit: vi.fn(async () => ({
    status: 'accepted',
    run: { runId: `run_${'1'.repeat(32)}` },
  })), ...(overrides.admission || {}) };
  const resolveInstallationId = overrides.resolveInstallationId || vi.fn(async () => 456);
  const instance = express();
  instance.use(express.json({ limit: '64kb' }));
  instance.use('/api/dispatch', createActionDispatchRouter({
    verifier, admission, resolveInstallationId,
    allowAppGate: overrides.allowAppGate,
    authoritativePublishing: overrides.authoritativePublishing,
    now: overrides.now,
  }));
  return { instance, verifier, admission, resolveInstallationId };
}

// Exercise the real preparer/identity contract without network readers, provider
// calls or persistence. The router's trusted resolver is the mocked boundary.
function publishingFixture() {
  const candidate: RequestedReviewCandidate = {
    repositoryId: body.repositoryId, owner: body.owner, repo: body.repo,
    prNumber: body.prNumber, headSha: body.headSha, baseSha: body.baseSha,
  };
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 20 },
  } });
  const prepared = preparePublishingPolicy({ content, source: {
    repositoryId: 987, repository: 'calltelemetry/ct-review-actions',
    sha: 'e'.repeat(40), path: 'policy/review.json',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, { baseUrl: 'https://gateway.example.invalid/v1', model: 'service-owned-model' });
  const current = { ...candidate, open: true, draft: true };
  const resolution: AuthoritativePublishingResolution = {
    current, prepared, identity: buildAuthoritativeReviewIdentity({ requested: candidate, current, policy: prepared.policy }),
  };
  const resolve = vi.fn(async (_candidate: RequestedReviewCandidate) => resolution);
  const authoritativePublishing = { expectedAppId: 789, repositoryIds: [123], resolver: { resolve } };
  const now = Date.parse(body.requestedAt);
  return { candidate, resolution, resolve, authoritativePublishing, now };
}

const terminalFailure = {
  version: 'WorkerTerminalFailure.v1',
  runId: `run_${'1'.repeat(32)}`,
  repositoryId: 123,
  owner: 'calltelemetry',
  repo: 'cisco-cdr',
  prNumber: 42,
  headSha: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  policyDigest: 'd'.repeat(64),
  configDigest: 'e'.repeat(64),
  executionAttempt: 1,
  checkId: 4242,
  failureClass: 'rate_limit',
} as const;

function completionApp(overrides: Record<string, any> = {}) {
  const verifier = {
    verify: vi.fn(async () => ({ workerTokenDigest: 'f'.repeat(64) })),
    ...(overrides.verifier || {}),
  };
  const repository = {
    markWorkerFailure: vi.fn(async (event: typeof terminalFailure) => ({ runId: event.runId, status: 'failed' as const })),
    ...(overrides.repository || {}),
  };
  const instance = express();
  instance.use(express.json({ limit: '64kb' }));
  instance.use('/api/dispatch', createActionDispatchRouter({
    verifier: { verify: vi.fn(async () => verified) },
    admission: { admit: vi.fn() },
    resolveInstallationId: vi.fn(),
    workerCompletion: { verifier, repository },
  }));
  return { instance, verifier, repository };
}

describe('POST /api/dispatch/action', () => {
  it('returns 202 only after the verified request is durably admitted', async () => {
    const fixture = app();
    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send(body);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      version: 'ActionDispatchAccepted.v1',
      status: 'accepted',
      runId: `run_${'1'.repeat(32)}`,
    });
    expect(fixture.admission.admit).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: body.deliveryId,
      repositoryId: 123,
      installationId: 456,
      publicationMode: 'disabled',
      terminalDeadline: expect.any(Number),
    }));
  });

  it('rejects missing bearer authentication and body-to-claim identity mismatches', async () => {
    expect((await request(app().instance).post('/api/dispatch/action').send(body)).status).toBe(401);
    const mismatch = app();
    const response = await request(mismatch.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send({ ...body, repositoryId: 999 });
    expect(response.status).toBe(403);
    expect(mismatch.admission.admit).not.toHaveBeenCalled();
  });

  it('accepts central repository_dispatch from ct-review-actions', async () => {
    const centralVerified = {
      repository: 'calltelemetry/ct-review-actions',
      repository_id: '99999',
      repository_owner_id: '99',
      run_id: '98765',
      run_attempt: '2',
      event_name: 'repository_dispatch',
      job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/repository-dispatch.yml@refs/heads/main',
      job_workflow_sha: 'd'.repeat(40),
    };
    const centralBody = {
      ...body,
      caller: {
        ...body.caller,
        eventName: 'repository_dispatch',
        workflowRef: centralVerified.job_workflow_ref,
      },
    };
    const fixture = app({ verifier: { verify: vi.fn(async () => centralVerified) } });
    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send(centralBody);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      version: 'ActionDispatchAccepted.v1',
      status: 'accepted',
      runId: `run_${'1'.repeat(32)}`,
    });
  });

  it('forwards refresh only from the central app-gate repository_dispatch boundary', async () => {
    const centralVerified = {
      repository: 'calltelemetry/ct-review-actions',
      repository_id: '99999',
      repository_owner_id: '99',
      run_id: '98765',
      run_attempt: '2',
      event_name: 'repository_dispatch',
      job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/repository-dispatch.yml@refs/heads/main',
      job_workflow_sha: 'd'.repeat(40),
    };
    const fixture = app({ allowAppGate: true, verifier: { verify: vi.fn(async () => centralVerified) } });
    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send({
        ...body,
        publishMode: 'app-gate',
        refreshRequested: true,
        caller: {
          ...body.caller,
          eventName: 'repository_dispatch',
          workflowRef: centralVerified.job_workflow_ref,
        },
      });

    expect(response.status).toBe(202);
    expect(fixture.admission.admit).toHaveBeenCalledWith(expect.objectContaining({ retryRequested: true }));
  });

  it('keeps app-gate disabled unless the verifier explicitly authorizes it', async () => {
    const fixture = app();
    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send({ ...body, publishMode: 'app-gate' });
    expect(response.status).toBe(403);
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });

  it('keeps the delivery digest stable when a lost-response retry refreshes only requestedAt', async () => {
    const fixture = app();
    for (const requestedAt of [new Date().toISOString(), new Date(Date.now() + 1_000).toISOString()]) {
      expect((await request(fixture.instance)
        .post('/api/dispatch/action')
        .set('Authorization', 'Bearer signed-oidc-token')
        .send({ ...body, requestedAt })).status).toBe(202);
    }
    const firstDigest = fixture.admission.admit.mock.calls[0][0].payloadDigest;
    const secondDigest = fixture.admission.admit.mock.calls[1][0].payloadDigest;
    expect(firstDigest).toBe(secondDigest);
  });

  it('fails closed when installation resolution or durable admission fails', async () => {
    const installFailure = app({ resolveInstallationId: vi.fn(async () => { throw new Error('not installed'); }) });
    expect((await request(installFailure.instance).post('/api/dispatch/action').set('Authorization', 'Bearer token').send(body)).status).toBe(503);

    const admissionFailure = app({ admission: { admit: vi.fn(async () => { throw new Error('database unavailable'); }) } });
    expect((await request(admissionFailure.instance).post('/api/dispatch/action').set('Authorization', 'Bearer token').send(body)).status).toBe(503);
  });

  it('accepts the real Action client request through real JWT verification without sending a provider key', async () => {
    const pair = await generateKeyPair('RS256');
    const jwk = await exportJWK(pair.publicKey);
    const signed = await new SignJWT(verified)
      .setProtectedHeader({ alg: 'RS256', kid: 'integration-key' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience('review-yeti-doks-dispatch')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    const verifier = new GitHubActionsOidcVerifier({
      keySet: createLocalJWKSet({ keys: [{ ...jwk, kid: 'integration-key', alg: 'RS256', use: 'sig' }] }),
      policy: {
        repositoryIds: new Set(['123']),
        ownerIds: new Set(['99']),
        workflowRefs: new Set([body.caller.workflowRef]),
        workflowShas: new Set([body.caller.workflowSha]),
        allowedEvents: new Set(['workflow_dispatch']),
        allowAppGate: false,
      },
    });
    const fixture = app({ verifier });
    const fetchBridge = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (new URL(String(url)).hostname === 'token.actions.githubusercontent.com') {
        return new Response(JSON.stringify({ value: signed }), { status: 200 });
      }
      const authorization = new Headers(init?.headers).get('authorization') || '';
      const serverResponse = await request(fixture.instance)
        .post('/api/dispatch/action')
        .set('Authorization', authorization)
        .send(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(serverResponse.body), { status: serverResponse.status });
    });
    const { dispatchAction } = await import(path.resolve(__dirname, '../../scripts/dispatch-doks-action.mjs'));

    const result = await dispatchAction({
      DOKS_DISPATCH_URL: 'https://review-bot.calltelemetry.com/api/dispatch/action',
      DOKS_OIDC_AUDIENCE: 'review-yeti-doks-dispatch',
      DOKS_PUBLISH_MODE: 'disabled',
      ACTION_SHA: body.actionSha,
      REPOSITORY_ID: String(body.repositoryId),
      REPOSITORY: `${body.owner}/${body.repo}`,
      PR_NUMBER: String(body.prNumber),
      HEAD_SHA: body.headSha,
      BASE_SHA: body.baseSha,
      GITHUB_RUN_ID: body.caller.runId,
      GITHUB_RUN_ATTEMPT: String(body.caller.runAttempt),
      GITHUB_EVENT_NAME: body.caller.eventName,
      GITHUB_WORKFLOW_REF: body.caller.workflowRef,
      GITHUB_WORKFLOW_SHA: body.caller.workflowSha,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-runtime-token',
      OPENROUTER_API_KEY: 'must-not-cross-the-boundary',
    }, fetchBridge);

    expect(result.status).toBe('accepted');
    expect(fixture.admission.admit).toHaveBeenCalledOnce();
    const admittedPayload = fixture.admission.admit.mock.calls[0][0];
    expect((admittedPayload as any).OPENROUTER_API_KEY).toBeUndefined();
    expect(JSON.stringify(admittedPayload)).not.toContain('must-not-cross-the-boundary');
  });

  it('re-arms a previously failed run and returns status accepted with run.status queued', async () => {
    let admittedInput: any;
    const admission = {
      admit: vi.fn(async (input: any) => {
        admittedInput = input;
        return {
          status: 'accepted' as const,
          deliveryId: input.deliveryId,
          repositoryId: input.repositoryId,
          installationId: input.installationId,
          publicationMode: input.publicationMode,
          receivedAt: input.receivedAt,
          terminalDeadline: input.terminalDeadline,
          payloadDigest: input.payloadDigest,
          run: {
            runId: `run_${'f'.repeat(32)}`,
            identity: input.identity,
            identityDigest: 'f'.repeat(64),
            effectivePolicyDigest: input.effectivePolicyDigest || input.identity.configDigest,
            effectiveConfigDigest: input.identity.configDigest,
            indexEpoch: 0,
            status: 'queued' as const,
            stage: 'admission' as const,
            attempt: 0,
            artifacts: {},
            createdAt: input.receivedAt,
            updatedAt: input.receivedAt,
          },
        };
      }),
    };
    const verifier = { verify: vi.fn(async () => ({ ...verified, run_attempt: '3' })) };
    const fixture = app({ admission, verifier });
    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send({
        ...body,
        deliveryId: `actions:98765:3:123:42:${'b'.repeat(40)}`,
        caller: {
          ...body.caller,
          runAttempt: 3,
        },
      });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      version: 'ActionDispatchAccepted.v1',
      status: 'accepted',
      runId: `run_${'f'.repeat(32)}`,
    });
    expect(admission.admit).toHaveBeenCalledOnce();
    const admissionResult = await admission.admit.mock.results[0].value;
    expect(admissionResult.status).toBe('accepted');
    expect(admissionResult.run.status).toBe('queued');
    expect(admissionResult.run.attempt).toBe(0);
    expect(admissionResult.run.stage).toBe('admission');
  });
});

describe('POST /api/dispatch/action authoritative publishing', () => {
  it('resolves exactly the enrolled candidate and admits the service-owned identity, policy, config and App', async () => {
    const publishing = publishingFixture();
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true });
    const dispatch: ActionDispatchRequest = { ...body, version: 'ActionDispatch.v1',
      publishMode: 'app-gate', caller: { ...body.caller, eventName: 'workflow_dispatch' } };
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token').send(dispatch);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ version: 'ActionDispatchAccepted.v1', status: 'accepted', runId: `run_${'1'.repeat(32)}` });
    expect(fixture.resolveInstallationId).toHaveBeenCalledExactlyOnceWith(body.owner, body.repo);
    expect(publishing.resolve).toHaveBeenCalledExactlyOnceWith(publishing.candidate);
    expect(fixture.admission.admit).toHaveBeenCalledExactlyOnceWith({
      deliveryId: body.deliveryId, eventName: body.caller.eventName,
      repositoryId: body.repositoryId, installationId: 456,
      receivedAt: publishing.now, terminalDeadline: publishing.now + TERMINAL_DEADLINE_MS,
      payloadDigest: sha256(actionDispatchDigestInput(dispatch)), publicationMode: 'app-gate',
      identity: publishing.resolution.identity,
      effectivePolicyDigest: publishing.resolution.prepared.policy.effectivePolicyDigest,
      authoritativeGate: { expectedAppId: 789, prepared: publishing.resolution.prepared },
    });
    const admitted = fixture.admission.admit.mock.calls[0][0];
    expect(admitted.identity).toBe(publishing.resolution.identity);
    expect(admitted.authoritativeGate.prepared).toBe(publishing.resolution.prepared);
    expect(admitted.identity.configDigest).toBe(publishing.resolution.prepared.policy.effectiveConfigDigest);
    expect(admitted.identity).not.toEqual(buildReviewRunIdentity(publishing.candidate));
    expect(admitted.authoritativeGate.prepared.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(publishing.resolution.current.draft).toBe(true);
    expect(fixture.resolveInstallationId.mock.invocationCallOrder[0]).toBeLessThan(publishing.resolve.mock.invocationCallOrder[0]);
    expect(publishing.resolve.mock.invocationCallOrder[0]).toBeLessThan(fixture.admission.admit.mock.invocationCallOrder[0]);
  });

  it('waits for trusted resolution to finish before calling admission', async () => {
    const publishing = publishingFixture();
    let finish!: (value: AuthoritativePublishingResolution) => void;
    publishing.resolve.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true });
    const pending = request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate' }).then((response) => response);
    try {
      await vi.waitFor(() => expect(publishing.resolve).toHaveBeenCalledOnce());
      expect(fixture.admission.admit).not.toHaveBeenCalled();
    } finally { finish(publishing.resolution); }
    expect((await pending).status).toBe(202);
    expect(fixture.admission.admit).toHaveBeenCalledOnce();
  });

  it('pauses enrolled admission before token mint without falling back to legacy', async () => {
    const publishing = publishingFixture();
    const fixture = app({ now: () => publishing.now, allowAppGate: true,
      authoritativePublishing: { ...publishing.authoritativePublishing, acceptNewRequests: false } });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Authoritative review admission is paused' });
    expect(fixture.verifier.verify).toHaveBeenCalledOnce();
    expect(fixture.resolveInstallationId).not.toHaveBeenCalled();
    expect(publishing.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });

  it.each([
    { repositoryIds: [999], publishMode: 'app-gate' },
    { repositoryIds: [123], publishMode: 'disabled' },
  ])('draining does not change other existing lanes ($publishMode)', async ({ repositoryIds, publishMode }) => {
    const publishing = publishingFixture();
    const fixture = app({ now: () => publishing.now, allowAppGate: true,
      authoritativePublishing: { ...publishing.authoritativePublishing, repositoryIds, acceptNewRequests: false } });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode });
    expect(response.status).toBe(202);
    expect(fixture.admission.admit).toHaveBeenCalledOnce();
    expect(publishing.resolve).not.toHaveBeenCalled();
  });

  it('ignores schema-allowed legacy policy hints and caller check ID when selecting authoritative config', async () => {
    const publishing = publishingFixture();
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate', checkId: 999,
        policy: { personas: 'caller-persona', maxInvestigationTurns: 99, laneCallBudget: 99 } });
    expect(response.status).toBe(202);
    expect(publishing.resolve).toHaveBeenCalledExactlyOnceWith(publishing.candidate);
    const admitted = fixture.admission.admit.mock.calls[0][0];
    expect(admitted.identity).toEqual(publishing.resolution.identity);
    expect(admitted.authoritativeGate).toEqual({ expectedAppId: 789, prepared: publishing.resolution.prepared });
    expect(admitted).not.toHaveProperty('policy');
    expect(admitted).not.toHaveProperty('checkId');
    expect(JSON.stringify(admitted)).not.toContain('caller-persona');
  });

  it.each([
    { label: 'option absent', enabled: false, repositoryIds: [123], publishMode: 'app-gate' },
    { label: 'unlisted repository with matching owner/name', enabled: true, repositoryIds: [999], publishMode: 'app-gate' },
    { label: 'disabled publishing in an enrolled repository', enabled: true, repositoryIds: [123], publishMode: 'disabled' },
    { label: 'disabled publishing in an unlisted repository', enabled: true, repositoryIds: [999], publishMode: 'disabled' },
  ])('preserves legacy admission for $label', async ({ enabled, repositoryIds, publishMode }) => {
    const publishing = publishingFixture();
    const fixture = app({ allowAppGate: true, now: () => publishing.now,
      authoritativePublishing: enabled ? { ...publishing.authoritativePublishing, repositoryIds } : undefined });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode });
    expect(response.status).toBe(202);
    expect(publishing.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.admit).toHaveBeenCalledOnce();
    const admitted = fixture.admission.admit.mock.calls[0][0];
    expect(admitted.identity).toEqual(buildReviewRunIdentity(publishing.candidate));
    expect(admitted.publicationMode).toBe(publishMode);
    expect(admitted).not.toHaveProperty('authoritativeGate');
    expect(admitted).not.toHaveProperty('effectivePolicyDigest');
  });

  it.each([
    { label: 'missing bearer', token: false, allowAppGate: true, repositoryId: 123, offset: 0, status: 401 },
    { label: 'OIDC coordinate mismatch', token: true, allowAppGate: true, repositoryId: 999, offset: 0, status: 403 },
    { label: 'app-gate disabled', token: true, allowAppGate: false, repositoryId: 123, offset: 0, status: 403 },
    { label: 'stale request', token: true, allowAppGate: true, repositoryId: 123, offset: 600_001, status: 400 },
  ])('rejects $label before trusted resolution', async ({ token, allowAppGate, repositoryId, offset, status }) => {
    const publishing = publishingFixture();
    const fixture = app({ ...publishing, allowAppGate, now: () => publishing.now + offset });
    const pending = request(fixture.instance).post('/api/dispatch/action');
    if (token) pending.set('Authorization', 'Bearer token');
    const response = await pending.send({ ...body, publishMode: 'app-gate', repositoryId });
    expect(response.status).toBe(status);
    expect(fixture.resolveInstallationId).not.toHaveBeenCalled();
    expect(publishing.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });

  it('does not resolve policy when installation resolution fails', async () => {
    const publishing = publishingFixture();
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true,
      resolveInstallationId: vi.fn(async () => { throw new Error('synthetic private installation diagnostic'); }) });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Review dispatch admission is temporarily unavailable' });
    expect(publishing.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });

  it.each(['error', 'non-error'])('fails closed with a redacted 503 on resolver %s rejection', async (kind) => {
    const publishing = publishingFixture();
    const diagnostic = 'ghs_SYNTHETIC_SECRET raw central policy and provider transcript';
    publishing.resolve.mockRejectedValue(kind === 'error' ? new Error(diagnostic) : diagnostic);
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Review dispatch admission is temporarily unavailable' });
    expect(response.text).not.toContain(diagnostic);
    expect(publishing.resolve).toHaveBeenCalledExactlyOnceWith(publishing.candidate);
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });

  it.each([
    ['zero App ID', { expectedAppId: 0 }], ['negative App ID', { expectedAppId: -1 }],
    ['fractional App ID', { expectedAppId: 1.5 }], ['unsafe App ID', { expectedAppId: Number.MAX_SAFE_INTEGER + 1 }],
    ['non-finite App ID', { expectedAppId: Infinity }], ['NaN App ID', { expectedAppId: NaN }],
    ['string App ID', { expectedAppId: '789' }], ['missing App ID', { expectedAppId: undefined }],
    ['empty allowlist', { repositoryIds: [] }], ['missing allowlist', { repositoryIds: undefined }],
    ['duplicate allowlist entry', { repositoryIds: [123, 123] }],
    ['oversized allowlist', { repositoryIds: Array.from({ length: 101 }, (_, index) => index + 1) }],
    ['zero repository ID', { repositoryIds: [123, 0] }], ['negative repository ID', { repositoryIds: [-1] }],
    ['fractional repository ID', { repositoryIds: [1.5] }], ['string repository ID', { repositoryIds: ['123'] }],
    ['unsafe repository ID', { repositoryIds: [Number.MAX_SAFE_INTEGER + 1] }],
    ['non-finite repository ID', { repositoryIds: [Infinity] }], ['NaN repository ID', { repositoryIds: [NaN] }],
  ])('throws synchronously for %s before a router can listen', (_label, invalid) => {
    const publishing = publishingFixture();
    const verifier = { verify: vi.fn() };
    const admission = { admit: vi.fn() };
    const resolveInstallationId = vi.fn();
    expect(() => createActionDispatchRouter({ verifier, admission, resolveInstallationId,
      authoritativePublishing: { ...publishing.authoritativePublishing, ...invalid } as ActionDispatchRouterOptions['authoritativePublishing'],
    })).toThrow('Invalid authoritative review admission configuration');
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(admission.admit).not.toHaveBeenCalled();
    expect(resolveInstallationId).not.toHaveBeenCalled();
    expect(publishing.resolve).not.toHaveBeenCalled();
  });

  it('accepts the 100-repository bound and uses the configured App ID unchanged', async () => {
    const publishing = publishingFixture();
    const fixture = app({ now: () => publishing.now, allowAppGate: true,
      authoritativePublishing: { ...publishing.authoritativePublishing, expectedAppId: Number.MAX_SAFE_INTEGER,
        repositoryIds: [123, ...Array.from({ length: 99 }, (_, index) => index + 1)] } });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate' });
    expect(response.status).toBe(202);
    expect(publishing.resolve).toHaveBeenCalledExactlyOnceWith(publishing.candidate);
    expect(fixture.admission.admit.mock.calls[0][0].authoritativeGate.expectedAppId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    { expectedAppId: 1 }, { repositoryIds: [123] }, { installationId: 1 },
    { authoritativePublishing: { expectedAppId: 1, repositoryIds: [123] } },
    { authoritativeGate: { expectedAppId: 1 } }, { prepared: {} }, { config: {} },
    { identity: {} }, { configDigest: 'f'.repeat(64) }, { effectiveConfigDigest: 'f'.repeat(64) },
    { effectivePolicyDigest: 'f'.repeat(64) }, { expectedPersonaIds: ['caller-lane'] },
    { policyRef: 'refs/heads/caller-policy' }, { transport: { model: 'caller-model' } },
    { policy: { config: {} } }, { policy: { expectedAppId: 1 } },
    { caller: { ...body.caller, config: {} } },
  ])('rejects request-supplied authority/config override %j at the strict schema boundary', async (override) => {
    const publishing = publishingFixture();
    const fixture = app({ ...publishing, now: () => publishing.now, allowAppGate: true });
    const response = await request(fixture.instance).post('/api/dispatch/action')
      .set('Authorization', 'Bearer token').send({ ...body, publishMode: 'app-gate', ...override });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid Action dispatch request' });
    expect(fixture.verifier.verify).not.toHaveBeenCalled();
    expect(fixture.resolveInstallationId).not.toHaveBeenCalled();
    expect(publishing.resolve).not.toHaveBeenCalled();
    expect(fixture.admission.admit).not.toHaveBeenCalled();
  });
});

// REL-733: the admission handler must actually observe
// REVIEW_YETI_TERMINAL_DEADLINE_MS, not just re-derive the same eagerly-resolved
// constant every other touched test already imports. TERMINAL_DEADLINE_MS is
// computed once at module load, so observing a different env value requires a
// fresh module graph -- vi.resetModules() + a dynamic re-import -- rather than
// the static import used by the rest of this file.
describe('POST /api/dispatch/action (configurable terminal deadline, REL-733)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function freshApp(overrides: Record<string, any> = {}) {
    const { createActionDispatchRouter: freshRouter } = await import('../../src/api/actionDispatchApi');
    const verifier = { verify: vi.fn(async () => verified), ...(overrides.verifier || {}) };
    const admission = { admit: vi.fn(async () => ({
      status: 'accepted',
      run: { runId: `run_${'1'.repeat(32)}` },
    })), ...(overrides.admission || {}) };
    const resolveInstallationId = overrides.resolveInstallationId || vi.fn(async () => 456);
    const instance = express();
    instance.use(express.json({ limit: '64kb' }));
    instance.use('/api/dispatch', freshRouter({ verifier, admission, resolveInstallationId }));
    return { instance, verifier, admission, resolveInstallationId };
  }

  it('admits a run whose terminalDeadline window equals the resolved REVIEW_YETI_TERMINAL_DEADLINE_MS', async () => {
    vi.stubEnv('REVIEW_YETI_TERMINAL_DEADLINE_MS', '2400000');
    vi.resetModules();
    const fixture = await freshApp();

    const response = await request(fixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send(body);

    expect(response.status).toBe(202);
    expect(fixture.admission.admit).toHaveBeenCalledOnce();
    const admitted = fixture.admission.admit.mock.calls[0][0];
    expect(admitted.terminalDeadline - admitted.receivedAt).toBe(2_400_000);
  });

  it('admits a run whose terminalDeadline window differs when REVIEW_YETI_TERMINAL_DEADLINE_MS differs, and matches the default when unset', async () => {
    vi.resetModules();
    const { DEFAULT_TERMINAL_DEADLINE_MS } = await import('../../src/config/terminalDeadline');
    const defaultFixture = await freshApp();
    const defaultResponse = await request(defaultFixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send(body);
    expect(defaultResponse.status).toBe(202);
    const defaultAdmitted = defaultFixture.admission.admit.mock.calls[0][0];
    expect(defaultAdmitted.terminalDeadline - defaultAdmitted.receivedAt).toBe(DEFAULT_TERMINAL_DEADLINE_MS);

    vi.stubEnv('REVIEW_YETI_TERMINAL_DEADLINE_MS', '1200000');
    vi.resetModules();
    const distinctFixture = await freshApp();
    const distinctResponse = await request(distinctFixture.instance)
      .post('/api/dispatch/action')
      .set('Authorization', 'Bearer signed-oidc-token')
      .send({ ...body, deliveryId: `actions:98765:2:123:42:${'c'.repeat(40)}`, headSha: 'c'.repeat(40) });
    expect(distinctResponse.status).toBe(202);
    const distinctAdmitted = distinctFixture.admission.admit.mock.calls[0][0];
    expect(distinctAdmitted.terminalDeadline - distinctAdmitted.receivedAt).toBe(1_200_000);
    expect(distinctAdmitted.terminalDeadline - distinctAdmitted.receivedAt).not.toBe(DEFAULT_TERMINAL_DEADLINE_MS);
  });
});

describe('POST /api/dispatch/completion', () => {
  it('returns a fixed 503 without invoking admission or authentication when completion is unconfigured', async () => {
    const fixture = app();
    const response = await request(fixture.instance).post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_worker_token').send(terminalFailure);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Worker completion is not configured' });
    expect(fixture.verifier.verify).not.toHaveBeenCalled();
    expect(fixture.admission.admit).not.toHaveBeenCalled();
    expect(fixture.resolveInstallationId).not.toHaveBeenCalled();
  });

  it('persists a typed terminal failure and returns no approval-shaped result', async () => {
    const fixture = completionApp();
    const response = await request(fixture.instance)
      .post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_worker_token')
      .send(terminalFailure);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: 'WorkerTerminalFailureAccepted.v1',
      runId: terminalFailure.runId,
      status: 'failed',
    });
    expect(fixture.repository.markWorkerFailure).toHaveBeenCalledWith(
      terminalFailure,
      expect.objectContaining({ workerTokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      expect.any(Number),
    );
    expect(JSON.stringify(response.body)).not.toMatch(/success|ship|approve/iu);
  });

  it('rejects missing or invalid worker authentication before touching durable state', async () => {
    const fixture = completionApp();
    expect((await request(fixture.instance).post('/api/dispatch/completion').send(terminalFailure)).status).toBe(401);
    const invalid = await request(fixture.instance)
      .post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_worker_token')
      .send({ ...terminalFailure, failureClass: 'provider-secret' });
    expect(invalid.status).toBe(400);
    expect(fixture.repository.markWorkerFailure).not.toHaveBeenCalled();
  });

  it('rejects a worker token or check identity that the verifier does not authorize', async () => {
    const fixture = completionApp({ verifier: { verify: vi.fn(async () => { throw new Error('wrong credential'); }) } });
    const response = await request(fixture.instance)
      .post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_worker_token')
      .send(terminalFailure);
    expect(response.status).toBe(403);
    expect(fixture.repository.markWorkerFailure).not.toHaveBeenCalled();
  });

  it('rejects a valid-looking bearer when its digest is not bound to this attempt', async () => {
    const fixture = completionApp({
      repository: {
        markWorkerFailure: vi.fn(async () => ({ runId: terminalFailure.runId, status: 'unauthorized' as const })),
      },
    });
    const response = await request(fixture.instance)
      .post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_arbitrary_public_check_reader')
      .send(terminalFailure);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toMatch(/token|digest|exception/iu);
  });

  it('derives only a bearer digest and never performs a public-check lookup', async () => {
    const verifier = createWorkerCompletionVerifier();
    const proof = await verifier.verify('ghs_synthetic_worker_token', terminalFailure);
    expect(proof.workerTokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(verifier.verify('ghp_wrong_token', terminalFailure)).rejects.toThrow(/ghs_/u);
  });

  it('returns a generic retryable 503 when failure persistence is unavailable', async () => {
    const fixture = completionApp({ repository: {
      markWorkerFailure: vi.fn(async () => { throw new Error('synthetic sensitive database diagnostic'); }),
    } });
    const response = await request(fixture.instance).post('/api/dispatch/completion')
      .set('Authorization', 'Bearer ghs_worker_token').send(terminalFailure);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Worker terminal failure could not be persisted' });
    expect(response.text).not.toContain('database diagnostic');
    expect(fixture.repository.markWorkerFailure).toHaveBeenCalledOnce();
  });
});
