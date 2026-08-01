import { generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';

describe('review bot readiness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires an OpenRouter key for review execution readiness', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');

    const response = await request(createApp()).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      configurationReady: true,
      openRouterReady: true,
    });
  });
});
