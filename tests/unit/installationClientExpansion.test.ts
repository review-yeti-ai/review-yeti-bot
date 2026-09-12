import { describe, expect, it, vi } from 'vitest';
import {
  GitHubInstallationClient,
  CHECK_CONTEXT_RAW_REVIEW,
  CHECK_CONTEXT_GATE,
  CHECK_CONTEXT_CI,
  MAX_CHECK_RUN_TITLE_CHARACTERS,
  REVIEW_REFRESH_ACTION,
} from '../../src/github/installationClient';
import { getGitHubAppRepositoryDispatchToken } from '../../src/github/appAuth';
import { SCHEMA_VERSION_CI_REQUEST } from '../../src/github/reviewCIRequest';
import crypto from 'node:crypto';

describe('GitHubInstallationClient expansion for Review Yeti Gate, CI, and Dispatch', () => {
  it('exports check context constants matching contracts', () => {
    expect(CHECK_CONTEXT_RAW_REVIEW).toBe('Review Yeti');
    expect(CHECK_CONTEXT_GATE).toBe('Review Yeti Gate');
    expect(CHECK_CONTEXT_CI).toBe('Review Yeti CI');
  });

  it('createCheck creates in_progress check with Review Yeti and propagates externalId', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 999 }),
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_dummytoken',
      fetchImplementation: fetchMock as any,
    });

    // Default call
    const id1 = await client.createCheck('owner', 'repo', 'a'.repeat(40));
    expect(id1).toBe(999);
    expect(capturedBody.name).toBe('Review Yeti');
    expect(capturedBody.external_id).toBeUndefined();

    // Call with externalId
    await client.createCheck('owner', 'repo', 'a'.repeat(40), 'run_12345:a1');
    expect(capturedBody.name).toBe('Review Yeti');
    expect(capturedBody.external_id).toBe('run_12345:a1');
  });

  it('offers the persisted refresh action only on a recoverable failed Review Yeti check', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const client = new GitHubInstallationClient({ token: 'ghs_dummytoken', fetchImplementation: fetchMock as any });

    await client.completeCheck({ owner: 'owner', repo: 'repo', checkId: 1, conclusion: 'failure',
      title: 'Review Yeti: review did not complete', summary: 'worker failed' });
    expect(capturedBody.actions).toEqual([REVIEW_REFRESH_ACTION]);

    await client.completeCheck({ owner: 'owner', repo: 'repo', checkId: 1, conclusion: 'failure',
      title: 'Review Yeti: BLOCK', summary: 'policy finding' });
    expect(capturedBody.actions).toBeUndefined();
  });

  it.each([
    ['label', 20],
    ['description', 40],
    ['identifier', 20],
  ] as const)('keeps the refresh action %s inside GitHub\'s %i-character limit', (field, limit) => {
    expect(REVIEW_REFRESH_ACTION[field].length).toBeGreaterThan(0);
    expect(REVIEW_REFRESH_ACTION[field].length).toBeLessThanOrEqual(limit);
  });

  it('publishGateCheck creates a completed check with Review Yeti Gate', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 1001 }),
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_dummytoken',
      fetchImplementation: fetchMock as any,
    });

    const id = await client.publishGateCheck('calltelemetry', 'dashboard', 'a'.repeat(40), {
      conclusion: 'success',
      title: 'Review Yeti Gate: Approved (SHIP)',
      summary: 'Policy eligibility gate passed with 0 blocking findings.',
      detailsUrl: 'https://review-bot.calltelemetry.com/runs/run_1',
    });

    expect(id).toBe(1001);
    expect(capturedUrl).toContain('/repos/calltelemetry/dashboard/check-runs');
    expect(capturedBody.name).toBe('Review Yeti Gate');
    expect(capturedBody.head_sha).toBe('a'.repeat(40));
    expect(capturedBody.status).toBe('completed');
    expect(capturedBody.conclusion).toBe('success');
    expect(capturedBody.output.title).toBe('Review Yeti Gate: Approved (SHIP)');
    expect(capturedBody.details_url).toBe('https://review-bot.calltelemetry.com/runs/run_1');
  });

  it('publishValidationCheck creates a completed check with Review Yeti CI', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 2002 }),
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_dummytoken',
      fetchImplementation: fetchMock as any,
    });

    const id = await client.publishValidationCheck('calltelemetry', 'dashboard', 'b'.repeat(40), {
      conclusion: 'failure',
      title: 'Review Yeti CI: Tests Failed',
      summary: 'Candidate test suite failed with exit code 1.',
    });

    expect(id).toBe(2002);
    expect(capturedUrl).toContain('/repos/calltelemetry/dashboard/check-runs');
    expect(capturedBody.name).toBe('Review Yeti CI');
    expect(capturedBody.head_sha).toBe('b'.repeat(40));
    expect(capturedBody.status).toBe('completed');
    expect(capturedBody.conclusion).toBe('failure');
  });

  it.each(['publishGateCheck', 'publishValidationCheck', 'completeCheck'] as const)(
    'accepts a 140-character title and rejects a 141-character title for %s',
    async (method) => {
      let capturedBody: any = null;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ id: 3003 }),
        };
      });
      const client = new GitHubInstallationClient({
        token: 'ghs_dummytoken',
        fetchImplementation: fetchMock as any,
      });
      const acceptedTitle = 't'.repeat(MAX_CHECK_RUN_TITLE_CHARACTERS);
      const publish = (title: string): Promise<number | void> => {
        if (method === 'publishGateCheck') {
          return client.publishGateCheck('owner', 'repo', 'a'.repeat(40), {
            conclusion: 'success', title, summary: 'summary',
          });
        }
        if (method === 'publishValidationCheck') {
          return client.publishValidationCheck('owner', 'repo', 'a'.repeat(40), {
            conclusion: 'success', title, summary: 'summary',
          });
        }
        return client.completeCheck({
          owner: 'owner', repo: 'repo', checkId: 3003, conclusion: 'success', title, summary: 'summary',
        });
      };

      await expect(publish(acceptedTitle)).resolves.toBe(method === 'completeCheck' ? undefined : 3003);
      expect(capturedBody.output.title).toBe(acceptedTitle);

      fetchMock.mockClear();
      await expect(publish(`${acceptedTitle}t`)).rejects.toThrow(/title/u);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('emitRepositoryDispatch posts to /repos/{owner}/{repo}/dispatches with event_type and client_payload', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: any = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body || '{}'));
      capturedHeaders = init?.headers;
      return {
        ok: true,
        status: 204,
        text: async () => '',
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_dispatch_token',
      fetchImplementation: fetchMock as any,
    });

    await client.emitRepositoryDispatch('calltelemetry', 'dashboard', 'custom-event', { foo: 'bar' });

    expect(capturedUrl).toContain('/repos/calltelemetry/dashboard/dispatches');
    expect(capturedBody.event_type).toBe('custom-event');
    expect(capturedBody.client_payload).toEqual({ foo: 'bar' });
    const authHeader = capturedHeaders instanceof Headers ? capturedHeaders.get('Authorization') : capturedHeaders?.Authorization;
    expect(authHeader).toBe('Bearer ghs_dispatch_token');
    const versionHeader = capturedHeaders instanceof Headers ? capturedHeaders.get('X-GitHub-Api-Version') : capturedHeaders?.['X-GitHub-Api-Version'];
    expect(versionHeader).toBe('2022-11-28');
  });

  it('emitCIRequest strictly validates review-yeti-ci-request.v1 payload before dispatch', async () => {
    let capturedBody: any = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 204,
        text: async () => '',
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_dispatch_token',
      fetchImplementation: fetchMock as any,
    });

    const validPayload = {
      schema_version: SCHEMA_VERSION_CI_REQUEST,
      repository_id: 12345,
      repository: 'calltelemetry/dashboard',
      pr_number: 100,
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      attempt_id: 'attempt-1',
      policy_digest: `sha256:${'c'.repeat(64)}`,
      validation_request_id: 'val-100-attempt-1',
    };

    await client.emitCIRequest('calltelemetry', 'dashboard', validPayload);

    expect(capturedBody.event_type).toBe('review-yeti-ci-request');
    expect(capturedBody.client_payload).toEqual(validPayload);

    // Invalid payload should throw before network transmission
    await expect(client.emitCIRequest('calltelemetry', 'dashboard', {
      ...validPayload,
      extraneous: 'disallowed',
    } as any)).rejects.toThrow('Invalid review-yeti-ci-request payload');
  });
});

describe('getGitHubAppRepositoryDispatchToken', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('mints a token scoped strictly to contents: write and tolerates implicit metadata: read', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/repos/calltelemetry/dashboard/installation')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 555 }),
        };
      }
      if (url.includes('/app/installations/555/access_tokens')) {
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.permissions).toEqual({ contents: 'write' });
        expect(body.repositories).toEqual(['dashboard']);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: 'ghs_scoped_dispatch_token',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { contents: 'write', metadata: 'read' },
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const result = await getGitHubAppRepositoryDispatchToken({
      appId: '4385771',
      privateKey: privateKeyPem,
      owner: 'calltelemetry',
      repo: 'dashboard',
    }, fetchMock as any);

    expect(result.token).toBe('ghs_scoped_dispatch_token');
    expect(result.permissions?.contents).toBe('write');
  });

  it('rejects an unsafe token granting unexpected permissions', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/repos/calltelemetry/dashboard/installation')) {
        return { ok: true, status: 200, json: async () => ({ id: 555 }) };
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          token: 'ghs_overprivileged_token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: 'write', pull_requests: 'write' }, // Unsafe!
        }),
      };
    });

    await expect(getGitHubAppRepositoryDispatchToken({
      appId: '4385771',
      privateKey: privateKeyPem,
      owner: 'calltelemetry',
      repo: 'dashboard',
    }, fetchMock as any)).rejects.toThrow('GitHub App repository dispatch token exchange returned an unsafe contract');
  });
});
