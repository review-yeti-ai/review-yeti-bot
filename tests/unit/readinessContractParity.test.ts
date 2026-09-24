import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { DispatcherLoopHealth, createDispatcherMetricsServer } from '../../src/dispatcherMetricsServer';
import { READINESS_CONTRACTS } from '../../src/health/readinessContract';

/**
 * REL-1069 follow-up: `/ready` is served by THREE implementations on the SAME
 * path, selected by entrypoint:
 *
 *   dist/index.js                    -> app configuration   (ct-review-live)
 *   dist/dispatchIndex.js            -> database reachable  (action-dispatch, mcp)
 *   dist/reviewJobDispatcherIndex.js -> dispatch loop       (job-dispatcher)
 *
 * They answer DIFFERENT questions, and that is legitimate. What was missing is any
 * statement of that fact: only one of the three named its service, so an operator
 * could not tell which implementation had answered or which subsystem a 503
 * pointed at.
 *
 * These tests pin the distinction rather than forcing agreement. Unifying the
 * three would require a read-only viewer to satisfy a database probe it does not
 * use -- the same mistake REL-1069 already made once by widening a pod's secret
 * surface to satisfy a probe.
 */
describe('the three /ready contracts are distinguishable', () => {
  it('app configuration contract self-identifies', async () => {
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('OPENAI_API_KEY', 'sk-bf-x');
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.internal/v1');

    const response = await request(createApp()).get('/ready');
    expect(response.body).toMatchObject({
      service: 'ct-review-bot',
      readinessContract: READINESS_CONTRACTS.configuration,
      // The app.ts comment promises these are "retained for existing
      // consumers", so pin them here. Counterfactual verified: dropping the
      // details argument from the readinessBody call left THIS test green
      // before these assertions existed -- the claim was unpinned where it was
      // made (REL-1069 review).
      configurationReady: true,
      openRouterReady: true,
      status: 'ready',
    });
    // Presence-pinned separately because uptimeSeconds is time-dependent.
    expect(typeof response.body.uptimeSeconds).toBe('number');
    vi.unstubAllEnvs();
  });

  it('database contract self-identifies', async () => {
    const app = createActionDispatchApp({
      verifier: { verify: vi.fn() } as never,
      admission: { admit: vi.fn() } as never,
      resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => true),
      allowAppGate: false,
    });
    const response = await request(app).get('/ready');
    expect(response.body).toMatchObject({
      service: 'ct-review-action-dispatch',
      readinessContract: READINESS_CONTRACTS.database,
      databaseReady: true,
    });
  });

  it('dispatch-loop contract self-identifies', async () => {
    const server = createDispatcherMetricsServer({ loopHealth: new DispatcherLoopHealth('worker-1') });
    const response = await request(server).get('/ready');
    expect(response.body).toMatchObject({
      service: 'review-yeti-job-dispatcher',
      readinessContract: READINESS_CONTRACTS.loop,
      ready: false,
    });
  });

  it('no two implementations report the same (service, contract) pair', async () => {
    // The property that makes the three distinguishable: a consumer branching on
    // this pair can never confuse one implementation for another. A fourth `/ready`
    // added without a distinct pair fails here.
    const appResponse = await request(createApp()).get('/ready');
    const dispatchResponse = await request(createActionDispatchApp({
      verifier: { verify: vi.fn() } as never,
      admission: { admit: vi.fn() } as never,
      resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => true),
      allowAppGate: false,
    })).get('/ready');
    const loopResponse = await request(
      createDispatcherMetricsServer({ loopHealth: new DispatcherLoopHealth('worker-1') }),
    ).get('/ready');

    const pairs = [appResponse, dispatchResponse, loopResponse].map(
      (r) => `${r.body.service}/${r.body.readinessContract}`,
    );
    expect(new Set(pairs).size).toBe(3);
    expect(pairs).toEqual([
      'ct-review-bot/configuration',
      'ct-review-action-dispatch/database',
      'review-yeti-job-dispatcher/loop',
    ]);
  });

  it('every contract maps a verdict to the same HTTP status', async () => {
    // The one thing the three SHOULD agree on: 200 for ready, 503 for not ready.
    const ready = await request(createActionDispatchApp({
      verifier: { verify: vi.fn() } as never,
      admission: { admit: vi.fn() } as never,
      resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => true),
      allowAppGate: false,
    })).get('/ready');
    const notReady = await request(createActionDispatchApp({
      verifier: { verify: vi.fn() } as never,
      admission: { admit: vi.fn() } as never,
      resolveInstallationId: vi.fn(),
      databaseReady: vi.fn(async () => false),
      allowAppGate: false,
    })).get('/ready');

    expect(ready.status).toBe(200);
    expect(notReady.status).toBe(503);
    expect(ready.body.status).toBe('ready');
    expect(notReady.body.status).toBe('not_ready');
  });
});
