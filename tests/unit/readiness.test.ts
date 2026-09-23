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

  it('still returns 503 when the webhook secret is genuinely absent', async () => {
    stubBifrostEnv({ GITHUB_WEBHOOK_SECRET: '', WEBHOOK_SECRET: '' });
    vi.stubEnv('WEBHOOK_SECRET', '');
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
  });

  it('still returns 503 when the App id is absent', async () => {
    stubBifrostEnv({ GITHUB_APP_ID: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
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
