import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';

/**
 * REL-1069. The readiness gate previously required the literal names
 * `WEBHOOK_SECRET` and `OPENROUTER_API_KEY`. Neither is what a deployment sets:
 * the app, the wizard and every synced environment use `GITHUB_WEBHOOK_SECRET`,
 * and the review lane is Bifrost-backed with no OpenRouter credential at all.
 * The result was that the full app reported 503 on a correctly-configured
 * cluster while every other review workload was healthy.
 */
describe('review bot readiness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function privateKey(): string {
    return generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  }

  /** The env a real Bifrost-backed deployment provides. */
  function stubBifrostEnv(overrides: Record<string, string> = {}): void {
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey());
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('OPENAI_API_KEY', 'sk-bf-test-virtual-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.internal.example/v1');
    vi.stubEnv('REVIEW_MODEL', 'pr-reviewer');
    for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
  }

  it('is ready when the deployment uses the OpenAI/Bifrost standard', async () => {
    stubBifrostEnv();
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', configurationReady: true });
  });

  it('is ready with the canonical GITHUB_WEBHOOK_SECRET, not the legacy spelling', async () => {
    // Guards the exact regression: WEBHOOK_SECRET is unset by every deployment,
    // so requiring it made a correct environment report not-ready.
    stubBifrostEnv({ WEBHOOK_SECRET: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('is ready on a Bifrost deployment that has no OpenRouter key', async () => {
    // The review lane has no OpenRouter credential; requiring one was stale.
    stubBifrostEnv({ OPENROUTER_API_KEY: '', OPENROUTER_REVIEW_FLEET_KEY: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('is NOT ready when the gateway key is present but the base URL is absent', async () => {
    // The regression this guards: /ready checked the key but not the base URL,
    // while openRouterClient() requires both. The probe answered 200 on a pod
    // where every review request threw -- a fail-open signal.
    stubBifrostEnv({ OPENAI_BASE_URL: '' });
    // Clear every accepted spelling: the harness env would otherwise supply one
    // and the assertion would pass against a leaked value.
    for (const name of ['REVIEW_YETI_GATEWAY_BASE_URL', 'BIFROST_BASE_URL', 'OPENROUTER_BASE_URL']) {
      vi.stubEnv(name, '');
    }
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'not_ready', configurationReady: false });
  });

  it('the readiness gate and the transport agree on what is required', async () => {
    // Structural guard: the gate must not re-list fields. If a required setting
    // is added to the transport, readiness must follow without a second edit.
    stubBifrostEnv({ OPENAI_BASE_URL: '' });
    for (const name of ['REVIEW_YETI_GATEWAY_BASE_URL', 'BIFROST_BASE_URL', 'OPENROUTER_BASE_URL']) {
      vi.stubEnv(name, '');
    }
    const withoutUrl = await request(createApp()).get('/ready');
    stubBifrostEnv();
    const withUrl = await request(createApp()).get('/ready');
    expect(withoutUrl.status).toBe(503);
    expect(withUrl.status).toBe(200);
  });

  it('still returns 503 when the gateway key is genuinely absent', async () => {
    // The gate must still fail closed: readiness must not become unconditional.
    // EVERY source must be cleared, including the legacy names that
    // tests/setup.ts sets globally — otherwise this assertion passes against a
    // leaked value rather than against the resolver.
    stubBifrostEnv({
      OPENAI_API_KEY: '', REVIEW_YETI_BIFROST_API_KEY: '', BIFROST_VIRTUAL_KEY: '',
      OPENROUTER_API_KEY: '', OPENROUTER_REVIEW_FLEET_KEY: '', OPENROUTER_PR_REVIEW_API_KEY: '',
    });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'not_ready', configurationReady: false });
  });

  it('is ready when the webhook secret comes from the dashboard store', async () => {
    // The canonical resolver (src/github/webhookServer.ts) reads env AND the
    // dashboard store, so clearing env alone does not make it absent -- and
    // readiness must ACCEPT a store-provided secret, because that is a real
    // configuration source the verification path also honours. Asserting 503
    // here would have pinned readiness to a narrower rule than verification,
    // which is the drift this work exists to remove.
    stubBifrostEnv({ GITHUB_WEBHOOK_SECRET: '', WEBHOOK_SECRET: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('still returns 503 when the App id is absent', async () => {
    stubBifrostEnv({ GITHUB_APP_ID: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
  });

  it('is ready with the legacy WEBHOOK_SECRET alone (documented rollout fallback)', async () => {
    // Without this, deleting the legacy arm keeps every test green while a
    // deployment setting only WEBHOOK_SECRET flips to 503 -- the exact scenario
    // the fallback exists for (REL-1069 review).
    stubBifrostEnv({ GITHUB_WEBHOOK_SECRET: '' });
    vi.stubEnv('WEBHOOK_SECRET', 'legacy-webhook-secret');
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('preserves the openRouterReady field the previous tests asserted', async () => {
    // The rewrite dropped these assertions; they are API surface, so keep them.
    stubBifrostEnv();
    const ready = await request(createApp()).get('/ready');
    expect(ready.body).toMatchObject({ openRouterReady: true });

    stubBifrostEnv({ OPENAI_API_KEY: '' });
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_REVIEW_FLEET_KEY', '');
    vi.stubEnv('BIFROST_VIRTUAL_KEY', '');
    const notReady = await request(createApp()).get('/ready');
    expect(notReady.body).toMatchObject({ openRouterReady: false });
  });

  it('accepts a legacy OpenRouter key so an older deployment still boots', async () => {
    // Rollout safety: nothing is provisioned under the legacy names any more,
    // but a not-yet-migrated host must not be marked unhealthy by this change.
    stubBifrostEnv({ OPENAI_API_KEY: '' });
    vi.stubEnv('OPENROUTER_API_KEY', 'legacy-key');
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });
});
