import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modulePath = path.resolve(__dirname, '../../scripts/dispatch-doks-action.mjs');

function environment(overrides: Record<string, string> = {}) {
  return {
    DOKS_DISPATCH_URL: 'https://review-bot.calltelemetry.com/api/dispatch/action',
    DOKS_OIDC_AUDIENCE: 'review-yeti-doks-dispatch',
    DOKS_PUBLISH_MODE: 'disabled',
    ACTION_SHA: 'a'.repeat(40),
    REPOSITORY_ID: '12345',
    REPOSITORY: 'calltelemetry/cisco-cdr',
    PR_NUMBER: '42',
    HEAD_SHA: 'b'.repeat(40),
    BASE_SHA: 'c'.repeat(40),
    GITHUB_RUN_ID: '98765',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'calltelemetry/ct-review-actions/.github/workflows/review.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: 'd'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token?x=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'actions-runtime-token',
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('DOKS Action dispatch client', () => {
  it('builds a versioned credential-minimal immutable request', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    const request = buildDispatchRequest(environment({
      OPENROUTER_API_KEY: 'must-not-leak',
      GITHUB_TOKEN: 'must-not-leak',
    }));

    expect(request).toEqual(expect.objectContaining({
      version: 'ActionDispatch.v1',
      repositoryId: 12345,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
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

  it.each(['', '0', '-1', '1.5', 'three'])(
    'rejects missing or invalid expected generation %j for central app-gate dispatch',
    async (expectedGeneration) => {
      const { buildDispatchRequest } = await import(modulePath);
      expect(() => buildDispatchRequest(environment({
        GITHUB_EVENT_NAME: 'repository_dispatch',
        DOKS_PUBLISH_MODE: 'app-gate',
        EXPECTED_GENERATION: expectedGeneration,
      }))).toThrow(/expected generation/i);
    },
  );

  it('does not require an expected generation outside central app-gate admission', async () => {
    const { buildDispatchRequest } = await import(modulePath);
    expect(buildDispatchRequest(environment()).expectedGeneration).toBeUndefined();
    expect(buildDispatchRequest(environment({
      GITHUB_EVENT_NAME: 'repository_dispatch',
      DOKS_PUBLISH_MODE: 'disabled',
    })).expectedGeneration).toBeUndefined();
  });

  it('accepts only the fixed HTTPS dispatch origin and exact path', async () => {
    const { validateDispatchEndpoint } = await import(modulePath);
    expect(validateDispatchEndpoint('https://review-bot.calltelemetry.com/api/dispatch/action').href)
      .toBe('https://review-bot.calltelemetry.com/api/dispatch/action');

    for (const unsafe of [
      'http://review-bot.calltelemetry.com/api/dispatch/action',
      'https://attacker.example/api/dispatch/action',
      'https://user:pass@review-bot.calltelemetry.com/api/dispatch/action',
      'https://review-bot.calltelemetry.com/api/dispatch/action?next=evil',
      'https://review-bot.calltelemetry.com/api/dispatch/action#fragment',
      'https://review-bot.calltelemetry.com/api/dispatch/other',
    ]) {
      expect(() => validateDispatchEndpoint(unsafe), unsafe).toThrow(/dispatch endpoint/i);
    }
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
    expect(fetchMock.mock.calls[1][0]).toBe('https://review-bot.calltelemetry.com/api/dispatch/action');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer signed-github-oidc-${'x'.repeat(32)}`);
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
    expect(fetchMock.mock.calls[2][0]).toBe('https://review-bot.calltelemetry.com/api/dispatch/action');
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
