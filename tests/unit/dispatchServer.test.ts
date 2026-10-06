import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';

function createApp(options: { ready?: boolean; paused?: boolean; storageInitialized?: () => boolean } = {}) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => options.ready ?? true),
    passthroughEnabled: options.paused,
    storageInitialized: options.storageInitialized,
    operatorPauseReadinessEnabled: options.paused,
    allowAppGate: false,
  });
}

describe('Action dispatch server endpoints', () => {
  describe('GET / (root operational status landing page)', () => {
    it('returns HTTP 200 OK with JSON operational payload by default', async () => {
      const response = await request(createApp()).get('/');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'review-yeti-action-dispatch',
        health: '/health',
        ready: '/ready',
        landing: 'https://review-bot.example.com',
      });
      expect(typeof response.body.timestamp).toBe('string');
    });

    it('returns HTTP 200 OK with HTML landing page when Accept: text/html is requested', async () => {
      const response = await request(createApp())
        .get('/')
        .set('Accept', 'text/html');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Review Yeti Action Dispatch');
      expect(response.text).toContain('Operational (200 OK)');
      expect(response.text).toContain('review-yeti-action-dispatch');
      expect(response.text).toContain('href="/health"');
      expect(response.text).toContain('href="/ready"');
    });

    it('returns HTTP 200 OK with JSON when Accept: application/json is requested', async () => {
      const response = await request(createApp())
        .get('/')
        .set('Accept', 'application/json');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('review-yeti-action-dispatch');
      expect(response.body.health).toBe('/health');
    });
  });

  describe('GET /health and GET /ready', () => {
    it('returns 200 for /health', async () => {
      const response = await request(createApp()).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('review-yeti-action-dispatch');
    });

    it('returns 200 for /ready when database is ready', async () => {
      const response = await request(createApp({ ready: true })).get('/ready');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.databaseReady).toBe(true);
    });

    it('returns 503 for /ready when database is not ready', async () => {
      const response = await request(createApp({ ready: false })).get('/ready');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.databaseReady).toBe(false);
    });

    it('keeps authenticated pause ingress ready while reporting that storage is not initialized', async () => {
      const databaseReady = vi.fn(async () => { throw new Error('storage must not be probed before initialization'); });
      const app = createActionDispatchApp({
        verifier: { verify: vi.fn() } as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        databaseReady,
        allowAppGate: false,
        passthroughEnabled: true,
        operatorPauseReadinessEnabled: true,
        storageInitialized: () => false,
      });

      const response = await request(app).get('/ready');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ready', service: 'ct-review-action-dispatch',
        readinessContract: 'pause-safe', operatorPauseEnabled: true,
        storageInitialized: false, databaseReady: false });
      expect(databaseReady).not.toHaveBeenCalled();
    });

    it('does not wait on an operational database probe for pause-safe readiness', async () => {
      const databaseReady = vi.fn(() => new Promise<boolean>(() => {}));
      const probe = { status: 'unavailable' as const, databaseReady: false,
        checkedAt: '2026-10-06T12:00:00.000Z', inProgress: true };
      const app = createActionDispatchApp({
        verifier: { verify: vi.fn() } as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        databaseReady,
        pauseDatabaseProbe: () => probe,
        allowAppGate: false,
        passthroughEnabled: true,
        operatorPauseReadinessEnabled: true,
        storageInitialized: () => true,
      });

      const response = await Promise.race([
        request(app).get('/ready'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);

      expect(response).not.toBeNull();
      expect(response).toMatchObject({ status: 200, body: {
        status: 'ready', readinessContract: 'pause-safe', storageInitialized: true,
        databaseReady: false, databaseProbeStatus: 'unavailable',
        databaseProbeCheckedAt: probe.checkedAt, databaseProbeInProgress: true,
      } });
      expect(databaseReady).not.toHaveBeenCalled();
    });

    it('gates ordinary dispatch routes while startup storage is unavailable', async () => {
      const admit = vi.fn();
      const app = createActionDispatchApp({
        verifier: { verify: vi.fn() } as any,
        admission: { admit } as any,
        resolveInstallationId: vi.fn(),
        databaseReady: vi.fn(async () => false),
        allowAppGate: false,
        passthroughEnabled: true,
        operatorPauseReadinessEnabled: true,
        storageInitialized: () => false,
      });

      const response = await request(app).get('/api/dispatch/status?runId=run_not_ready&attempt=1');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: 'Review dispatch storage is not initialized' });
      expect(admit).not.toHaveBeenCalled();
    });

    it('releases database-backed routes after the storage initializer recovers', async () => {
      const storageInitialized = vi.fn(() => false);
      const getRunStatus = vi.fn(async () => null);
      const app = createActionDispatchApp({
        verifier: { verify: vi.fn() } as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        runStatusRepository: { getRunStatus } as any,
        databaseReady: vi.fn(async () => true),
        allowAppGate: false,
        passthroughEnabled: true,
        operatorPauseReadinessEnabled: true,
        storageInitialized,
      });

      const beforeRecovery = await request(app)
        .get('/api/dispatch/status?runId=run_not_ready&attempt=1')
        .set('Authorization', 'Bearer synthetic-worker-token');
      expect(beforeRecovery.status).toBe(503);
      expect(getRunStatus).not.toHaveBeenCalled();

      storageInitialized.mockReturnValue(true);
      const afterRecovery = await request(app)
        .get('/api/dispatch/status?runId=run_not_ready&attempt=1')
        .set('Authorization', 'Bearer synthetic-worker-token');
      expect(afterRecovery.status).toBe(404);
      expect(getRunStatus).toHaveBeenCalledExactlyOnceWith('run_not_ready', 1);
    });

    it('keeps Review CI and provider lease routes unmounted throughout operator pause', async () => {
      const wake = vi.fn();
      const claim = vi.fn();
      const acquire = vi.fn();
      const renew = vi.fn();
      const release = vi.fn();
      const app = createActionDispatchApp({
        verifier: { verify: vi.fn() } as any,
        admission: { admit: vi.fn() } as any,
        resolveInstallationId: vi.fn(),
        databaseReady: vi.fn(async () => true),
        allowAppGate: false,
        passthroughEnabled: true,
        operatorPauseReadinessEnabled: true,
        storageInitialized: () => true,
        ci: { verifier: { verify: vi.fn() }, service: { wake, claim } } as any,
        providerLease: { acquire, renew, release } as any,
      });

      const ciResponse = await request(app).post('/api/dispatch/ci/event').send({});
      const leaseResponse = await request(app).post('/api/dispatch/provider-lease').send({});

      expect(ciResponse.status).toBe(404);
      expect(leaseResponse.status).toBe(404);
      expect(wake).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(renew).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });
  });
});
