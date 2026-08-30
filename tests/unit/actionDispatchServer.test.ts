import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';

function app(ready = true) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => ready),
    allowAppGate: false,
  });
}

describe('admission-only Action dispatch server', () => {
  it('exposes health and database-backed readiness only', async () => {
    expect((await request(app()).get('/health')).body).toEqual(expect.objectContaining({
      status: 'ok',
      service: 'review-yeti-action-dispatch',
    }));
    expect((await request(app(true)).get('/ready')).status).toBe(200);
    expect((await request(app(false)).get('/ready')).status).toBe(503);
  });

  it('does not mount webhook, dashboard, provider, metrics, or generic API routes', async () => {
    for (const route of ['/webhook', '/api/webhook/github', '/api/dashboard', '/api/router/providers', '/metrics']) {
      expect((await request(app()).post(route).send({})).status, route).toBe(404);
    }
  });

  it('mounts only the authenticated Action admission route under /api/dispatch', async () => {
    expect((await request(app()).post('/api/dispatch/action').send({})).status).toBe(401);
    expect((await request(app()).post('/api/dispatch/other').send({})).status).toBe(404);
  });
});
