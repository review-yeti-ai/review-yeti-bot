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

  it('depends on OmniRoute health, not catalog advertisement of every exact route', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubEnv('WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('OMNIROUTE_BASE_URL', 'http://omniroute.test');

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'healthy',
      cryptography: { status: 'healthy' },
      providerSummary: { configuredCount: 9, activeCount: 8 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await request(createApp()).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      configurationReady: true,
      omniRouteReady: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/monitoring\/health$/);
  });
});
