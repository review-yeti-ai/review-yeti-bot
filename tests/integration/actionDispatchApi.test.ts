import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter, createWorkerCompletionVerifier } from '../../src/api/actionDispatchApi';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GitHubActionsOidcVerifier } from '../../src/auth/githubActionsOidc';
import path from 'node:path';

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
  instance.use('/api/dispatch', createActionDispatchRouter({ verifier, admission, resolveInstallationId }));
  return { instance, verifier, admission, resolveInstallationId };
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

describe('POST /api/dispatch/completion', () => {
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
});
