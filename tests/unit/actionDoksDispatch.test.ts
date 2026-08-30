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

  it('fails closed on missing OIDC capability, non-202 responses, and malformed receipts', async () => {
    const { dispatchAction } = await import(modulePath);
    await expect(dispatchAction(environment({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }), vi.fn())).rejects.toThrow(/id-token: write/i);
    await expect(dispatchAction(environment({
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com.attacker.example/token',
    }), vi.fn())).rejects.toThrow(/invalid for host pipelines\.actions\.githubusercontent\.com\.attacker\.example/i);

    const rejected = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: `signed-github-oidc-${'x'.repeat(32)}` }), { status: 200 }))
      .mockResolvedValueOnce(new Response('no', { status: 503 }));
    await expect(dispatchAction(environment(), rejected)).rejects.toThrow(/503/u);

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
});
