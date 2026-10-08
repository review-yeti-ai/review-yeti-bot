import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT } from '../../src/review/incompleteP2RecoveryLimits';

const modulePath = path.resolve(__dirname, '../../scripts/dispatch-doks-action.mjs');

function environment(overrides: Record<string, string> = {}) {
  return {
    DOKS_DISPATCH_URL: 'https://review-bot.example.com/api/dispatch/action',
    DOKS_OIDC_AUDIENCE: 'review-yeti-doks-dispatch',
    DOKS_PUBLISH_MODE: 'disabled',
    ACTION_SHA: 'a'.repeat(40),
    REPOSITORY_ID: '12345',
    REPOSITORY: 'exampleorg/example-api',
    PR_NUMBER: '42',
    HEAD_SHA: 'b'.repeat(40),
    BASE_SHA: 'c'.repeat(40),
    GITHUB_RUN_ID: '98765',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'exampleorg/example-review-actions/.github/workflows/review.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: 'd'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token?x=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-runtime-token',
    ...overrides,
  };
}

type ActionDispatchRequest = {
  deliveryId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  caller: { eventName: string };
};

function actionPassthroughReceipt(request: ActionDispatchRequest, overrides: Record<string, unknown> = {}) {
  return {
    version: 'ActionDispatchPassthrough.v1',
    status: 'passthrough',
    reason: 'operator_global_passthrough',
    reviewStarted: false,
    candidateState: 'current',
    deliveryId: request.deliveryId,
    repositoryId: request.repositoryId,
    owner: request.owner,
    repo: request.repo,
    prNumber: request.prNumber,
    headSha: request.headSha,
    baseSha: request.baseSha,
    eventName: request.caller.eventName,
    callerKind: 'direct',
    verdict: 'SHIP',
    expectedLanes: 0,
    completedLanes: 0,
    publicationReceiptAvailable: true,
    publicationId: 'f'.repeat(64),
    auditDigest: 'e'.repeat(64),
    publicationState: 'published',
    reviewCheckId: 5001,
    gateCheckId: 5002,
    mergeEligible: true,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('DOKS Action dispatch client', () => {
  it('keeps the standalone recovery window aligned with the service contract', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const recoveryEnvironment = (attempt: number) => environment({
      GITHUB_EVENT_NAME: 'repository_dispatch', DOKS_PUBLISH_MODE: 'app-gate',
      EXPECTED_GENERATION: String(attempt), REFRESH_REQUESTED: 'true',
      REFRESH_EXECUTION_ATTEMPT: String(attempt - 1), INCOMPLETE_P2_RECOVERY: 'true',
    });
    expect(buildDispatchRequest(recoveryEnvironment(MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT)))
      .toMatchObject({ incompleteP2Recovery: true, expectedGeneration: MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT });
    expect(() => buildDispatchRequest(recoveryEnvironment(MAX_INCOMPLETE_P2_RECOVERY_EXECUTION_ATTEMPT + 1)))
      .toThrow(/bounded exact-generation/);
  });
  it('emits the new candidate flag only for an explicit bounded central refresh', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({ GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '2', REFRESH_REQUESTED: 'true',
      REFRESH_EXECUTION_ATTEMPT: '1', INCOMPLETE_P2_RECOVERY: 'true' }));
    expect(request.incompleteP2Recovery).toBe(true);
    expect(buildDispatchRequest(environment({ INCOMPLETE_P2_RECOVERY: 'false' }))).not.toHaveProperty('incompleteP2Recovery');
  });

  it('carries the central qualification image digest only for the exact qualification target', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const digest = `sha256:${'a'.repeat(64)}`;
    const request = buildDispatchRequest(environment({
      REPOSITORY_ID: '1409547157', REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      GITHUB_EVENT_NAME: 'repository_dispatch', DOKS_PUBLISH_MODE: 'app-gate',
      QUALIFICATION_RUNTIME_IMAGE_DIGEST: digest,
    }));
    expect(request.qualificationRuntimeImageDigest).toBe(digest);
    expect(buildDispatchRequest(environment())).not.toHaveProperty('qualificationRuntimeImageDigest');
    expect(() => buildDispatchRequest(environment({
      REPOSITORY_ID: '1409547157', REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      QUALIFICATION_RUNTIME_IMAGE_DIGEST: 'a'.repeat(64),
    }))).toThrow(/qualification runtime image digest/iu);
    expect(() => buildDispatchRequest(environment({ QUALIFICATION_RUNTIME_IMAGE_DIGEST: digest })))
      .toThrow(/exact qualification target/u);
    expect(() => buildDispatchRequest(environment({
      REPOSITORY_ID: '1409547157', REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      DOKS_PUBLISH_MODE: 'app-gate', GITHUB_EVENT_NAME: 'repository_dispatch',
    }))).toThrow(/requires a qualification runtime image digest/u);
    expect(() => buildDispatchRequest(environment({
      REPOSITORY_ID: '1409547158', REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      DOKS_PUBLISH_MODE: 'app-gate', GITHUB_EVENT_NAME: 'repository_dispatch',
      QUALIFICATION_RUNTIME_IMAGE_DIGEST: digest,
    }))).toThrow(/exact qualification target/u);
  });

  it('accepts the qualification endpoint only with the exact target and trusted digest context', async () => {
    const { validateDispatchEndpoint } = await import(modulePath);
    const url = 'https://review-bot.calltelemetry.com/api/qualification/dispatch/action';
    const context = { repositoryId: 1_409_547_157, owner: 'review-yeti-ai',
      repo: 'review-yeti-qualification', publishMode: 'app-gate',
      qualificationRuntimeImageDigest: `sha256:${'a'.repeat(64)}` };

    expect(validateDispatchEndpoint(url, context).href).toBe(url);
    expect(() => validateDispatchEndpoint(url)).toThrow(/qualification endpoint/i);
    expect(() => validateDispatchEndpoint(url, { ...context, repositoryId: 1_409_547_158 }))
      .toThrow(/qualification target/i);
    expect(() => validateDispatchEndpoint(url, { ...context, qualificationRuntimeImageDigest: undefined }))
      .toThrow(/qualification runtime image digest/i);
    expect(() => validateDispatchEndpoint(url.replace('review-bot.calltelemetry.com', 'dispatch.internal.example.org'), context))
      .toThrow(/qualification endpoint host/i);
    expect(() => validateDispatchEndpoint('https://review-bot.calltelemetry.com/api/dispatch/action', context))
      .toThrow(/qualification target must use/i);
  });

  it('posts the exact qualification request to the isolated endpoint only with its image claim', async () => {
    const { dispatchAction } = await import(modulePath);
    const digest = `sha256:${'a'.repeat(64)}`;
    const endpoint = 'https://review-bot.calltelemetry.com/api/qualification/dispatch/action';
    const dispatchEnvironment = environment({
      DOKS_DISPATCH_URL: endpoint, REPOSITORY_ID: '1409547157',
      REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      DOKS_PUBLISH_MODE: 'app-gate', GITHUB_EVENT_NAME: 'repository_dispatch',
      QUALIFICATION_RUNTIME_IMAGE_DIGEST: digest,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 'ActionDispatchAccepted.v1',
        status: 'accepted', runId: `run_${'1'.repeat(32)}` }), { status: 202 }));

    await expect(dispatchAction(dispatchEnvironment, fetchMock)).resolves.toMatchObject({ status: 'accepted' });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(endpoint);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)))
      .toMatchObject({ repositoryId: 1_409_547_157, owner: 'review-yeti-ai',
        repo: 'review-yeti-qualification', qualificationRuntimeImageDigest: digest });
  });

  it.each([
    ['ordinary endpoint', 'https://review-bot.calltelemetry.com/api/dispatch/action'],
    ['another host', 'https://dispatch.internal.example.org/api/qualification/dispatch/action'],
  ])('refuses the qualification request through %s before fetching an OIDC token', async (_label, url) => {
    const { dispatchAction } = await import(modulePath);
    const fetchMock = vi.fn();
    const env = environment({
      DOKS_DISPATCH_URL: url, REPOSITORY_ID: '1409547157',
      REPOSITORY: 'review-yeti-ai/review-yeti-qualification',
      DOKS_PUBLISH_MODE: 'app-gate', GITHUB_EVENT_NAME: 'repository_dispatch',
      QUALIFICATION_RUNTIME_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    });

    await expect(dispatchAction(env, fetchMock)).rejects.toThrow(/qualification (?:target|endpoint)/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts candidate-unavailable SHIP only with null current coordinates and no durable receipt claims', async () => {
    const { buildDispatchRequest, dispatchAction, writeDispatchOutputs } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const unavailable = actionPassthroughReceipt(request, {
      candidateState: 'unavailable', headSha: null, baseSha: null,
      publicationState: 'unavailable', publicationReceiptAvailable: null,
      publicationId: null, auditDigest: null, reviewCheckId: null, gateCheckId: null, mergeEligible: false,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(unavailable), { status: 200 }));

    const result = await dispatchAction(dispatchEnvironment, fetchMock);

    expect(result).toMatchObject({ candidateState: 'unavailable', headSha: null, baseSha: null,
      verdict: 'SHIP', expectedLanes: 0, completedLanes: 0, publicationState: 'unavailable',
      publicationReceiptAvailable: null, publicationId: null, auditDigest: null,
      reviewCheckId: null, gateCheckId: null, mergeEligible: false });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-doks-authority-unavailable-'));
    const outputPath = path.join(directory, 'output');
    writeDispatchOutputs(outputPath, result);
    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('verdict=SHIP');
    expect(output).toContain('review-status=OPERATOR_AUTHORITY_UNAVAILABLE');
    expect(output).toContain('merge-eligible=false');
    expect(output).toContain('current candidate and policy authority are unavailable');
    expect(output).not.toContain(request.headSha);
    expect(output).not.toContain(request.baseSha);
    expect(output).not.toContain('OPERATOR_EXEMPTION_PUBLISHED');
    expect(output).not.toMatch(/(?:=|\s)null\b/u);
  });

  it.each([
    { headSha: 'b'.repeat(40) },
    { baseSha: 'c'.repeat(40) },
    { publicationId: 'f'.repeat(64), auditDigest: 'e'.repeat(64), publicationReceiptAvailable: null },
    { publicationReceiptAvailable: false },
    { gateCheckId: 5002 },
    { mergeEligible: true },
  ])('rejects candidate-unavailable receipt with authority/receipt claims %j', async (override) => {
    const { buildDispatchRequest, dispatchAction } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const unavailable = actionPassthroughReceipt(request, {
      candidateState: 'unavailable', headSha: null, baseSha: null,
      publicationState: 'unavailable', publicationReceiptAvailable: null,
      publicationId: null, auditDigest: null, reviewCheckId: null, gateCheckId: null, mergeEligible: false,
      ...override,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(unavailable), { status: 200 }));
    await expect(dispatchAction(dispatchEnvironment, fetchMock)).rejects.toThrow(/invalid passthrough receipt/u);
  });

  it.each([
    { REFRESH_REQUESTED: 'false' }, { EXPECTED_GENERATION: '4', REFRESH_EXECUTION_ATTEMPT: '3' },
    { EXPECTED_GENERATION: '1' }, { REFRESH_EXECUTION_ATTEMPT: '2' },
    { DOKS_PUBLISH_MODE: 'disabled' }, { GITHUB_EVENT_NAME: 'pull_request' },
  ])('rejects an unbound P2 candidate before dispatch: %j', async (overrides) => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(() => buildDispatchRequest(environment({ GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '2', REFRESH_REQUESTED: 'true',
      REFRESH_EXECUTION_ATTEMPT: '1', INCOMPLETE_P2_RECOVERY: 'true', ...overrides }))).toThrow(/bounded exact-generation/);
  });

  it.each(['1', 'TRUE', 'yes'])('rejects ambiguous P2 flag %s', async (flag) => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(() => buildDispatchRequest(environment({ INCOMPLETE_P2_RECOVERY: flag }))).toThrow('INCOMPLETE_P2_RECOVERY');
  });
  it('builds a versioned credential-minimal immutable request', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({
      OPENROUTER_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
    }));

    expect(request).toEqual(expect.objectContaining({
      version: 'ActionDispatch.v1',
      repositoryId: 12345,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 42,
      headSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      actionSha: 'a'.repeat(40),
      publishMode: 'disabled',
      caller: expect.objectContaining({ runId: '98765', runAttempt: 2 }),
    }));
    expect(JSON.stringify(request)).not.toContain('must-not-leak');
  });

  it('accepts repository_dispatch event for central dispatch callers', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'app-gate',
      EXPECTED_GENERATION: '3',
    }));
    expect(request.caller.eventName).toBe('repository_dispatch');
    expect(request.expectedGeneration).toBe(3);
  });

  it.each(['0', '-1', '1.5', 'three'])(
    'rejects an invalid supplied expected generation %j for app-gate dispatch',
    async (expectedGeneration) => {
      const { buildDispatchRequest } = await import(modulePath);
      expect(() => buildDispatchRequest(environment({
        GITHUB_EVENT_NAME: 'repository_dispatch',
        DOKS_PUBLISH_MODE: 'app-gate',
        EXPECTED_GENERATION: expectedGeneration,
      }))).toThrow(/expected generation/i);
    },
  );

  it('leaves a missing repository_dispatch generation for the verified service identity to enforce', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'app-gate',
      EXPECTED_GENERATION: '',
    })).expectedGeneration).toBeUndefined();
  });

  it('does not require an expected generation outside central app-gate admission', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(buildDispatchRequest(environment()).expectedGeneration).toBeUndefined();
    expect(buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'disabled',
    })).expectedGeneration).toBeUndefined();
  });

  it('carries an explicit refresh request without changing the legacy default payload', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const legacy = buildDispatchRequest(environment());
    expect((legacy as Record<string, unknown>).refreshRequested).toBeUndefined();

    const refresh = buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      REFRESH_REQUESTED: 'true',
      REFRESH_EXECUTION_ATTEMPT: '1',
    }));
    expect(refresh.refreshRequested).toBe(true);
    expect(refresh.refreshExecutionAttempt).toBe(1);
    expect(() => buildDispatchRequest(environment({ REFRESH_REQUESTED: 'yes' })))
      .toThrow(/REFRESH_REQUESTED/u);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects an invalid refresh execution attempt %s', async (attempt) => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(() => buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      REFRESH_REQUESTED: 'true',
      REFRESH_EXECUTION_ATTEMPT: attempt,
    }))).toThrow(/REFRESH_EXECUTION_ATTEMPT must be a positive integer/u);
  });

  it('requires an execution attempt for a central refresh dispatch', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(() => buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      REFRESH_REQUESTED: 'true',
    }))).toThrow(/REFRESH_EXECUTION_ATTEMPT is required/u);
  });

  it('does not invent an execution attempt for a non-central refresh request', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'pull_request',
      REFRESH_REQUESTED: 'true',
    }));
    expect(request.refreshRequested).toBe(true);
    expect(request.refreshExecutionAttempt).toBeUndefined();
  });

  it('accepts only an https DNS endpoint with the exact admission path and no credentials', async () => {
    const { validateDispatchEndpoint } = await import(modulePath);
    for (const ok of [
      'https://review-bot.example.com/api/dispatch/action',
      'https://dispatch.internal.example.org/api/dispatch/action',
    ]) {
      expect(validateDispatchEndpoint(ok).href).toBe(ok);
    }

    for (const unsafe of [
      'http://review-bot.example.com/api/dispatch/action',
      'https://user:pass@review-bot.example.com/api/dispatch/action',
      'https://review-bot.example.com/api/dispatch/action?next=evil',
      'https://review-bot.example.com/api/dispatch/action#fragment',
      'https://review-bot.example.com/api/dispatch/other',
      'https://review-bot.example.com:8443/api/dispatch/action',
      'https://localhost/api/dispatch/action',
      'https://app.localhost/api/dispatch/action',
      'https://intranet/api/dispatch/action',
      'https://127.0.0.1/api/dispatch/action',
      'https://[::1]/api/dispatch/action',
      '',
      'not a url',
    ]) {
      expect(() => validateDispatchEndpoint(unsafe), unsafe).toThrow(/dispatch endpoint/i);
    }
  });

  it('fails with a clear error when the caller supplies no dispatch endpoint', async () => {
    const { dispatchAction } = await import(modulePath);
    const fetchMock = vi.fn();
    await expect(dispatchAction(environment({ DOKS_DISPATCH_URL: '' }), fetchMock)).rejects.toThrow(/DOKS_DISPATCH_URL is required/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mutable action refs and unsupported publication modes', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(() => buildDispatchRequest(environment({ ACTION_SHA: 'v1' }))).toThrow(/action sha/i);
    expect(() => buildDispatchRequest(environment({ DOKS_PUBLISH_MODE: 'publish-everything' }))).toThrow(/publish mode/i);
  });

  it.each([
    'pipelines.actions.githubusercontent.com',
    'run-actions-3-azure-eastus.actions.githubusercontent.com',
    'token.actions.githubusercontent.com',
    'vstoken.actions.githubusercontent.com',
  ])('requests the fixed GitHub OIDC audience from %s and posts the token only to the dispatch endpoint', async (oidcHost) => {
    const { dispatchAction } = await import(modulePath);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 'ActionDispatchAccepted.v1',
        status: 'accepted',
        runId: `run_${'1'.repeat(32)}`,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }));

    const result = await dispatchAction(environment({
      ACTIONS_ID_TOKEN_REQUEST_URL: `https://${oidcHost}/token?x=1`,
    }), fetchMock);

    expect(result).toEqual({ version: 'ActionDispatchAccepted.v1', status: 'accepted', runId: `run_${'1'.repeat(32)}` });
    const oidcUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(oidcUrl.origin).toBe(`https://${oidcHost}`);
    expect(oidcUrl.searchParams.get('audience')).toBe('review-yeti-doks-dispatch');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer actions-runtime-token');
    expect(fetchMock.mock.calls[1][0]).toBe('https://review-bot.example.com/api/dispatch/action');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer signed-github-oidc-${'x'.repeat(32)}`);
  });

  it('accepts an HTTP 200 paused-SHIP receipt only when identity matches and writes truthful SHIP outputs', async () => {
    const { buildDispatchRequest, dispatchAction, writeDispatchOutputs } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const passthrough = actionPassthroughReceipt(request);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(passthrough), { status: 200 }));

    const result = await dispatchAction(dispatchEnvironment, fetchMock);

    expect(result).toEqual(passthrough);
    expect(result).not.toHaveProperty('runId');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const posted = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(posted.deliveryId).toBe(passthrough.deliveryId);
    expect(posted.caller.eventName).toBe(passthrough.eventName);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-doks-passthrough-'));
    const outputPath = path.join(directory, 'output');
    writeDispatchOutputs(outputPath, result);
    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('verdict=SHIP');
    expect(output).toContain('review-status=OPERATOR_EXEMPTION_PUBLISHED');
    expect(output).toContain('gate-decision=SHIP_OPERATOR_EXEMPTION');
    expect(output).toContain('merge-eligible=true');
    expect(output).toContain(`rationale=Operator pause authorized a SHIP exemption for ${request.owner}/${request.repo}#${request.prNumber} at ${request.headSha}; 0 review lanes ran; publication published; audit ${'e'.repeat(64)}.`);
    expect(output).not.toContain('PENDING');
    expect(output).not.toContain('run_');
  });

  it('writes pending operator publication as SHIP intent without merge eligibility', async () => {
    const { buildDispatchRequest, writeDispatchOutputs } = await import(modulePath);
    const request = buildDispatchRequest(environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' }));
    const pending = actionPassthroughReceipt(request, {
      publicationState: 'pending', reviewCheckId: null, gateCheckId: null, mergeEligible: false,
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-doks-pending-passthrough-'));
    const outputPath = path.join(directory, 'output');

    writeDispatchOutputs(outputPath, pending);
    const output = fs.readFileSync(outputPath, 'utf8');

    expect(output).toContain('verdict=SHIP');
    expect(output).toContain('review-status=OPERATOR_EXEMPTION_PENDING');
    expect(output).toContain('gate-decision=SHIP_OPERATOR_EXEMPTION');
    expect(output).toContain('merge-eligible=false');
    expect(output).toContain('publication pending;');
    expect(output).not.toContain('OPERATOR_EXEMPTION_PUBLISHED');
    expect(output).not.toContain('merge-eligible=true');
  });

  it.each([
    ['published', { reviewCheckId: 5001, gateCheckId: 5002, mergeEligible: true }],
    ['pending', { reviewCheckId: null, gateCheckId: null, mergeEligible: false }],
  ] as Array<[string, Record<string, unknown>]>)('accepts a legacy %s receipt only with durable bindings', async (publicationState,
    stateBindings) => {
      const { buildDispatchRequest, dispatchAction } = await import(modulePath);
      const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
      const request = buildDispatchRequest(dispatchEnvironment);
      const legacyReceipt = actionPassthroughReceipt(request, { publicationState, ...stateBindings }) as Record<string, unknown>;
      delete legacyReceipt.publicationReceiptAvailable;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(legacyReceipt), { status: 200 }));

      const result = await dispatchAction(dispatchEnvironment, fetchMock);

      expect(result).toMatchObject({
        publicationState,
        publicationReceiptAvailable: true,
        publicationId: 'f'.repeat(64),
        auditDigest: 'e'.repeat(64),
        ...stateBindings,
      });
    });

  it.each([
    ['current', true],
    ['legacy', false],
  ] as const)('accepts a raw-review-only partial binding for a %s pending receipt', async (_receiptKind, currentReceipt) => {
    const { buildDispatchRequest, dispatchAction } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const receipt = actionPassthroughReceipt(request, {
      publicationState: 'pending', reviewCheckId: 5001, gateCheckId: null, mergeEligible: false,
      ...(currentReceipt ? { publicationReceiptAvailable: true } : {}),
    }) as Record<string, unknown>;
    if (!currentReceipt) delete receipt.publicationReceiptAvailable;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));

    const result = await dispatchAction(dispatchEnvironment, fetchMock);

    expect(result).toMatchObject({ publicationState: 'pending', publicationReceiptAvailable: true,
      reviewCheckId: 5001, gateCheckId: null, mergeEligible: false });
  });

  it.each([
    ['unconfirmed', null, null, null],
    ['absent', false, null, null],
    ['durable receipt known', true, 'f'.repeat(64), 'e'.repeat(64)],
  ] as const)('accepts unavailable publication with %s receipt availability as logical SHIP', async (_label,
    publicationReceiptAvailable, publicationId, auditDigest) => {
      const { buildDispatchRequest, dispatchAction, writeDispatchOutputs } = await import(modulePath);
      const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
      const request = buildDispatchRequest(dispatchEnvironment);
      const unavailable = actionPassthroughReceipt(request, {
        publicationState: 'unavailable',
        publicationReceiptAvailable,
        publicationId,
        auditDigest,
        reviewCheckId: null,
        gateCheckId: null,
        mergeEligible: false,
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(unavailable), { status: 200 }));

      const result = await dispatchAction(dispatchEnvironment, fetchMock);

      expect(result).toMatchObject({
        verdict: 'SHIP',
        expectedLanes: 0,
        completedLanes: 0,
        publicationState: 'unavailable',
        publicationReceiptAvailable,
        publicationId,
        auditDigest,
        reviewCheckId: null,
        gateCheckId: null,
        mergeEligible: false,
      });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-doks-unavailable-'));
      const outputPath = path.join(directory, 'output');
      writeDispatchOutputs(outputPath, result);
      const output = fs.readFileSync(outputPath, 'utf8');
      expect(output).toContain('verdict=SHIP');
      expect(output).toContain('review-status=OPERATOR_EXEMPTION_UNAVAILABLE');
      expect(output).toContain('gate-decision=SHIP_OPERATOR_EXEMPTION');
      expect(output).toContain('merge-eligible=false');
      expect(output).toContain('zero review lanes');
      expect(output).toContain('official check publication is unavailable');
      expect(output).not.toContain('OPERATOR_EXEMPTION_PENDING');
      expect(output).not.toContain('OPERATOR_EXEMPTION_PUBLISHED');
      expect(output).not.toContain('audit eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      expect(output).not.toContain('f'.repeat(64));
      expect(output).not.toMatch(/(?:=|\s)null\b/u);
      expect(output).not.toContain('merge-eligible=true');
    });

  it.each([
    ['receipt availability absent with receipt IDs', { publicationReceiptAvailable: false }],
    ['unknown receipt availability with receipt IDs', { publicationReceiptAvailable: null }],
    ['known receipt availability without receipt ID', { publicationReceiptAvailable: true, publicationId: null }],
    ['known receipt availability without audit digest', { publicationReceiptAvailable: true, auditDigest: null }],
    ['unavailable receipt marked known but without IDs', { publicationState: 'unavailable',
      publicationReceiptAvailable: true, publicationId: null, auditDigest: null, reviewCheckId: null, gateCheckId: null,
      mergeEligible: false }],
    ['unavailable receipt claiming merge eligibility', { publicationState: 'unavailable', publicationReceiptAvailable: null,
      publicationId: null, auditDigest: null, mergeEligible: true }],
    ['published receipt without merge eligibility', { publicationState: 'published', mergeEligible: false }],
    ['published receipt unavailable', { publicationState: 'published', publicationReceiptAvailable: false }],
    ['pending receipt unavailable', { publicationState: 'pending', publicationReceiptAvailable: null }],
    ['pending receipt with both checks already bound', { publicationState: 'pending', reviewCheckId: 5001,
      gateCheckId: 5002, mergeEligible: false }],
    ['pending receipt with Gate bound before Review', { publicationState: 'pending', reviewCheckId: null,
      gateCheckId: 5002, mergeEligible: false }],
    ['unrecognized publication state', { publicationState: 'unknown' }],
    ['unrecognized receipt availability', { publicationReceiptAvailable: 'unknown' }],
  ] as Array<[string, Record<string, unknown>]>)('rejects invalid publication binding: %s', async (_case, override) => {
    const { buildDispatchRequest, dispatchAction } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const receipt = actionPassthroughReceipt(request, override);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));

    await expect(dispatchAction(dispatchEnvironment, fetchMock)).rejects.toThrow(/invalid passthrough receipt/u);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['delivery id', { deliveryId: 'actions:other-run:2:12345:42:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
    ['repository id', { repositoryId: 54321 }],
    ['owner', { owner: 'otherorg' }],
    ['repository name', { repo: 'other-api' }],
    ['pull request number', { prNumber: 43 }],
    ['head SHA', { headSha: 'e'.repeat(40) }],
    ['base SHA', { baseSha: 'f'.repeat(40) }],
    ['caller event', { eventName: 'pull_request' }],
    ['caller kind', { callerKind: 'unknown' }],
    ['skip reason', { reason: 'not_authorized' }],
    ['review state', { reviewStarted: true }],
    ['published state without merge eligibility', { publicationState: 'published', mergeEligible: false }],
    ['published state without both official check IDs', { mergeEligible: true, gateCheckId: null }],
    ['merge eligibility without the Review Yeti check ID', { mergeEligible: true, reviewCheckId: null }],
    ['merge eligibility without published state', { publicationState: 'pending', mergeEligible: true }],
  ] as Array<[string, Record<string, unknown>]>)('rejects passthrough receipts with mismatched %s', async (_field, override) => {
    const { buildDispatchRequest, dispatchAction } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const receipt = actionPassthroughReceipt(request, override);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));
    const sleep = vi.fn(async () => {});

    await expect(dispatchAction(dispatchEnvironment, fetchMock, { sleep }))
      .rejects.toThrow(/invalid passthrough receipt|different Action request/u);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('accepts passthrough only at HTTP 200 and never treats it as admission', async () => {
    const { buildDispatchRequest, dispatchAction } = await import(modulePath);
    const dispatchEnvironment = environment({ DOKS_PUBLISH_MODE: 'app-gate', EXPECTED_GENERATION: '3' });
    const request = buildDispatchRequest(dispatchEnvironment);
    const passthrough = actionPassthroughReceipt(request);
    const accepted = {
      version: 'ActionDispatchAccepted.v1',
      status: 'accepted',
      runId: `run_${'a'.repeat(32)}`,
    };

    for (const [status, body] of [[202, passthrough], [200, accepted]] as const) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
      await expect(dispatchAction(dispatchEnvironment, fetchMock)).rejects.toThrow(/receipt/u);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  it('retries transient dispatch transport failures with the identical idempotent delivery', async () => {
    const { dispatchAction } = await import(modulePath);
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 'ActionDispatchAccepted.v1',
        status: 'duplicate',
        runId: `run_${'2'.repeat(32)}`,
      }), { status: 202 }));

    const result = await dispatchAction(environment(), fetchMock, { sleep });

    expect(result).toEqual({
      version: 'ActionDispatchAccepted.v1',
      status: 'duplicate',
      runId: `run_${'2'.repeat(32)}`,
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const dispatchCalls = fetchMock.mock.calls.slice(1);
    expect(dispatchCalls.map(([, init]) => init?.body)).toEqual([
      dispatchCalls[0][1]?.body,
      dispatchCalls[0][1]?.body,
      dispatchCalls[0][1]?.body,
    ]);
  });

  it('retries transient GitHub OIDC token transport failures before dispatch', async () => {
    const { dispatchAction } = await import(modulePath);
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 'ActionDispatchAccepted.v1',
        status: 'accepted',
        runId: `run_${'3'.repeat(32)}`,
      }), { status: 202 }));

    const result = await dispatchAction(environment(), fetchMock, { sleep });

    expect(result.status).toBe('accepted');
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(new URL(String(fetchMock.mock.calls[0][0])).hostname).toBe('pipelines.actions.githubusercontent.com');
    expect(fetchMock.mock.calls[1][0]).toEqual(fetchMock.mock.calls[0][0]);
    expect(fetchMock.mock.calls[2][0]).toBe('https://review-bot.example.com/api/dispatch/action');
  });

  it('retries transient OIDC HTTP failures and rejects permanent OIDC failures immediately', async () => {
    const { dispatchAction } = await import(modulePath);
    const sleep = vi.fn(async () => {});
    const transient = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 'ActionDispatchAccepted.v1',
        status: 'accepted',
        runId: `run_${'5'.repeat(32)}`,
      }), { status: 202 }));

    const result = await dispatchAction(environment(), transient, { sleep });

    expect(result.status).toBe('accepted');
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(transient.mock.calls[1][0]).toEqual(transient.mock.calls[0][0]);

    const permanentSleep = vi.fn(async () => {});
    const permanent = vi.fn().mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(dispatchAction(environment(), permanent, { sleep: permanentSleep })).rejects.toThrow(/OIDC token request failed with HTTP 403/u);
    expect(permanent).toHaveBeenCalledOnce();
    expect(permanentSleep).not.toHaveBeenCalled();
  });

  it('bounds dispatch retries and does not retry an actionable client rejection', async () => {
    const { dispatchAction } = await import(modulePath);
    const sleep = vi.fn(async () => {});
    const unavailable = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(dispatchAction(environment(), unavailable, { sleep })).rejects.toThrow(/after 3 attempts.*fetch failed/iu);
    expect(unavailable).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);

    const rejected = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown repository_id 42' }), { status: 400 }));
    await expect(dispatchAction(environment(), rejected, { sleep })).rejects.toThrow(/unknown repository_id 42/u);
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);

    const invalidGeneration = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Invalid Action dispatch request', invalidFields: ['expectedGeneration'],
      }), { status: 400 }));
    await expect(dispatchAction(environment(), invalidGeneration, { sleep }))
      .rejects.toThrow(/expectedGeneration/u);
    expect(invalidGeneration).toHaveBeenCalledTimes(2);

    const conflict = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Expected review generation does not match durable service state',
        expectedGeneration: 3,
        durableGeneration: 1,
      }), { status: 409 }));
    await expect(dispatchAction(environment(), conflict, { sleep }))
      .rejects.toThrow(/expected review generation.*durable service state/i);
    expect(conflict).toHaveBeenCalledTimes(2);

    const oidcSleep = vi.fn(async () => {});
    const oidcUnavailable = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(dispatchAction(environment(), oidcUnavailable, { sleep: oidcSleep }))
      .rejects.toThrow(/OIDC token request transport failed after 3 attempts.*fetch failed/iu);
    expect(oidcUnavailable).toHaveBeenCalledTimes(3);
    expect(oidcSleep).toHaveBeenCalledTimes(2);
  });

  it('fails closed on missing OIDC capability, non-202 responses, and malformed receipts', async () => {
    const { dispatchAction } = await import(modulePath);
    await expect(dispatchAction(environment({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }), vi.fn())).rejects.toThrow(/id-token: write/i);

    for (const unsafeHost of [
      'pipelines.actions.githubusercontent.com.attacker.example',
      'run-actions-3-azure-eastus.actions.githubusercontent.com.attacker',
      'run_actions.actions.githubusercontent.com',
    ]) {
      const fetchMock = vi.fn();
      await expect(dispatchAction(environment({
        ACTIONS_ID_TOKEN_REQUEST_URL: `https://${unsafeHost}/token`,
      }), fetchMock)).rejects.toThrow(new RegExp(`invalid for host ${unsafeHost.replaceAll('.', '\\.')}`, 'i'));
      expect(fetchMock).not.toHaveBeenCalled();
    }

    const rejected = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    await expect(dispatchAction(environment(), rejected, { sleep: async () => {} })).rejects.toThrow(/503/u);

    // The operator's reason must survive into the error. Without it a dispatch failure is a bare
    // status code, and the one line that explains it is the one line discarded.
    const explained = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unknown repository_id 42' }), { status: 400 }));
    await expect(dispatchAction(environment(), explained)).rejects.toThrow(/unknown repository_id 42/u);

    // Bounded, and single-line: a hostile or enormous body must not become the error message.
    const flooded = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response('z'.repeat(10_000), { status: 400 }));
    const floodedError = await dispatchAction(environment(), flooded).catch((error: Error) => error);
    expect(floodedError).toBeInstanceOf(Error);
    expect((floodedError as Error).message).toMatch(/HTTP 400/u);
    expect((floodedError as Error).message.length).toBeLessThan(700);

    // A multi-line body must collapse to ONE line. Without the whitespace normalisation every
    // other assertion here still passes, so this is the only thing holding the single-line
    // contract in place.
    const multiline = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{\n  "error": "unknown repository_id 42",\n  "hint": "check org settings"\n}', { status: 400 }));
    const multilineError = await dispatchAction(environment(), multiline).catch((error: Error) => error);
    expect((multilineError as Error).message).toBe(
      'DOKS dispatch failed with HTTP 400: { "error": "unknown repository_id 42", "hint": "check org settings" }',
    );
    expect((multilineError as Error).message).not.toContain('\n');

    // An empty (or whitespace-only) body must not leave a dangling `: ` on the message.
    const silent = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response('   \n  ', { status: 400 }));
    const silentError = await dispatchAction(environment(), silent).catch((error: Error) => error);
    expect((silentError as Error).message).toBe('DOKS dispatch failed with HTTP 400');

    // An unreadable body must not replace the failure it is describing.
    const unreadable = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce({
        status: 400,
        arrayBuffer: () => Promise.reject(new Error('stream already consumed')),
      });
    await expect(dispatchAction(environment(), unreadable)).rejects.toThrow(/HTTP 400/u);

    const malformed = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'accepted' }), { status: 202 }));
    await expect(dispatchAction(environment(), malformed)).rejects.toThrow(/acceptance receipt/i);
  });

  it('writes nonterminal Action outputs after acceptance', async () => {
    const { writeDispatchOutputs } = await import(modulePath);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-doks-output-'));
    const outputPath = path.join(directory, 'output');
    const runId = `run_${'4'.repeat(32)}`;
    writeDispatchOutputs(outputPath, { version: 'ActionDispatchAccepted.v1', status: 'duplicate', runId });
    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('review-status=DISPATCHED');
    expect(output).toContain('gate-decision=PENDING');
    expect(output).toContain('merge-eligible=false');
    expect(output).toContain('verdict=NO_VERDICT');
    expect(output).toContain(`rationale=Durably admitted as ${runId} (duplicate); awaiting the Review Yeti App gate.`);
  });

  it('does not forward CHECK_ID over the wire even when present in the environment', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({
      CHECK_ID: '12345678',
    }));
    expect((request as Record<string, unknown>).checkId).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('12345678');
  });
});
