import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';

/**
 * REL-1069. The readiness gate previously required the literal names
 * `WEBHOOK_SECRET` and `OPENROUTER_API_KEY`. Neither is what a deployment sets:
 * the app, the wizard and every synced environment use `GITHUB_WEBHOOK_SECRET`,
 * and the review lane uses an explicit Cloudflare AI Gateway Run-token pair.
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

  /** The env a configured Cloudflare AI Gateway deployment provides. */
  function stubCloudflareEnv(overrides: Record<string, string> = {}): void {
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey());
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('CLOUDFLARE_AIG_RUN_TOKEN', 'test-run-token');
    vi.stubEnv('CLOUDFLARE_AIG_BASE_URL', 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/custom-example/v1');
    vi.stubEnv('REVIEW_MODEL', 'test-model-pending-selection');
    for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']) {
      vi.stubEnv(name, '');
    }
    for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
  }

  it('is ready when the deployment uses the dedicated Cloudflare Run-token pair', async () => {
    stubCloudflareEnv();
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', configurationReady: true });
  });

  it('is ready with the canonical GITHUB_WEBHOOK_SECRET, not the legacy spelling', async () => {
    // Guards the exact regression: WEBHOOK_SECRET is unset by every deployment,
    // so requiring it made a correct environment report not-ready.
    stubCloudflareEnv({ WEBHOOK_SECRET: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('is ready without an OpenRouter key', async () => {
    stubCloudflareEnv({ OPENROUTER_API_KEY: '', OPENROUTER_REVIEW_FLEET_KEY: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('is NOT ready when the gateway key is present but the base URL is absent', async () => {
    // The regression this guards: /ready checked the key but not the base URL,
    // while openRouterClient() requires both. The probe answered 200 on a pod
    // where every review request threw -- a fail-open signal.
    stubCloudflareEnv({ CLOUDFLARE_AIG_BASE_URL: '' });
    // Clear every accepted spelling: the harness env would otherwise supply one
    // and the assertion would pass against a leaked value.
    for (const name of ['OPENAI_BASE_URL', 'REVIEW_YETI_GATEWAY_BASE_URL', 'OPENROUTER_BASE_URL']) {
      vi.stubEnv(name, '');
    }
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'not_ready', configurationReady: false });
  });

  it('the readiness gate and the transport agree on what is required', async () => {
    // Structural guard: the gate must not re-list fields. If a required setting
    // is added to the transport, readiness must follow without a second edit.
    stubCloudflareEnv({ CLOUDFLARE_AIG_BASE_URL: '' });
    for (const name of ['OPENAI_BASE_URL', 'REVIEW_YETI_GATEWAY_BASE_URL', 'OPENROUTER_BASE_URL']) {
      vi.stubEnv(name, '');
    }
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const withoutUrl = await request(createApp()).get('/ready');
    stubCloudflareEnv();
    const withUrl = await request(createApp()).get('/ready');
    expect(withoutUrl.status).toBe(503);
    expect(withUrl.status).toBe(200);
  });

  it('is NOT ready on a scheme-less base URL that the transport would reject', async () => {
    // A malformed configured URL must fail closed, so /ready cannot answer 200 while
    // openRouterClient() threw at request time -- a fail-open probe.
    stubCloudflareEnv({ CLOUDFLARE_AIG_BASE_URL: 'gateway.ai.cloudflare.com/v1' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
  });

  it('is NOT ready on a plaintext base URL', async () => {
    // A plaintext gateway would ship diffs off the intended path.
    stubCloudflareEnv({ CLOUDFLARE_AIG_BASE_URL: 'http://gateway.ai.cloudflare.com/v1' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
  });

  it('still returns 503 when the gateway key is genuinely absent', async () => {
    // The gate must still fail closed: readiness must not become unconditional.
    // EVERY source must be cleared, including the legacy names that
    // tests/setup.ts sets globally — otherwise this assertion passes against a
    // leaked value rather than against the resolver.
    stubCloudflareEnv({
      CLOUDFLARE_AIG_RUN_TOKEN: '', CLOUDFLARE_AIG_API_TOKEN: '',
      OPENAI_API_KEY: '',
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
    stubCloudflareEnv({ GITHUB_WEBHOOK_SECRET: '', WEBHOOK_SECRET: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('still returns 503 when the App id is absent', async () => {
    stubCloudflareEnv({ GITHUB_APP_ID: '' });
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(503);
  });

  it('is ready with the legacy WEBHOOK_SECRET alone (documented rollout fallback)', async () => {
    // Without this, deleting the legacy arm keeps every test green while a
    // deployment setting only WEBHOOK_SECRET flips to 503 -- the exact scenario
    // the fallback exists for (REL-1069 review).
    stubCloudflareEnv({ GITHUB_WEBHOOK_SECRET: '' });
    vi.stubEnv('WEBHOOK_SECRET', 'legacy-webhook-secret');
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  it('preserves the openRouterReady field the previous tests asserted', async () => {
    // The rewrite dropped these assertions; they are API surface, so keep them.
    stubCloudflareEnv();
    const ready = await request(createApp()).get('/ready');
    expect(ready.body).toMatchObject({ openRouterReady: true });

    stubCloudflareEnv({ CLOUDFLARE_AIG_RUN_TOKEN: '', CLOUDFLARE_AIG_BASE_URL: '' });
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_REVIEW_FLEET_KEY', '');
    vi.stubEnv('OPENROUTER_BASE_URL', '');
    const notReady = await request(createApp()).get('/ready');
    expect(notReady.body).toMatchObject({ openRouterReady: false });
  });

  it('accepts a legacy OpenRouter key so an older deployment still boots', async () => {
    // Rollout safety: nothing is provisioned under the legacy names any more,
    // but a not-yet-migrated host must not be marked unhealthy by this change.
    stubCloudflareEnv({ CLOUDFLARE_AIG_RUN_TOKEN: '', CLOUDFLARE_AIG_BASE_URL: '' });
    vi.stubEnv('OPENROUTER_API_KEY', 'legacy-key');
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
    const response = await request(createApp()).get('/ready');
    expect(response.status).toBe(200);
  });

  describe('a missing webhook secret must not crash the probe', () => {
    // The regression this guards (REL-1069 review, P1): the gate called the
    // THROWING resolveWebhookSecret() inside an async Express handler. Express 4
    // does not catch rejected promises, so with no secret configured the probe
    // HUNG and minted an unhandled rejection instead of returning 503 -- and on
    // modern Node that can terminate a process without a rejection listener.
    it('returns 503 when nothing configures the webhook secret', async () => {
      stubCloudflareEnv({ GITHUB_WEBHOOK_SECRET: '', WEBHOOK_SECRET: '' });
      vi.stubEnv('WEBHOOK_SECRET', '');
      const store = await import('../../src/persistence/dashboardStore');
      vi.spyOn(store.dashboardStore, 'getGitHubAppConfig').mockReturnValue(
        { webhookSecret: '', webhookSecretRaw: '' } as never,
      );

      const response = await request(createApp()).get('/ready');
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ status: 'not_ready', configurationReady: false });
    });

    it('hasWebhookSecret is false rather than throwing when unconfigured', async () => {
      const store = await import('../../src/persistence/dashboardStore');
      vi.spyOn(store.dashboardStore, 'getGitHubAppConfig').mockReturnValue(
        { webhookSecret: '', webhookSecretRaw: '' } as never,
      );
      vi.stubEnv('WEBHOOK_SECRET', '');
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
      const { hasWebhookSecret } = await import('../../src/github/webhookServer');
      expect(hasWebhookSecret()).toBe(false);
    });
  });
});
