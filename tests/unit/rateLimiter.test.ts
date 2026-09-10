import { describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createRateLimiter, getClientIp } from '../../src/security/rateLimiter';
import { createActionDispatchApp } from '../../src/dispatchServer';

describe('createRateLimiter Express middleware', () => {
  it('ignores spoofed X-Forwarded-For when trustProxy is false', () => {
    const req = {
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      socket: { remoteAddress: '198.51.100.1' },
    } as unknown as Request;
    expect(getClientIp(req, false)).toBe('198.51.100.1');
  });

  it('extracts client IP properly from req.ip or X-Forwarded-For when trustProxy is true', () => {
    const reqWithIp = {
      ip: '203.0.113.195',
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;
    expect(getClientIp(reqWithIp, true)).toBe('203.0.113.195');

    const reqWithoutIp = {
      headers: { 'x-forwarded-for': '198.51.100.22, 10.0.0.1' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;
    expect(getClientIp(reqWithoutIp, true)).toBe('198.51.100.22');

    const reqFallback = {
      headers: {},
      socket: { remoteAddress: '192.0.2.1' },
    } as unknown as Request;
    expect(getClientIp(reqFallback, true)).toBe('192.0.2.1');
  });

  it('allows requests within the limit and sets rate limit headers', async () => {
    let mockNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 3,
      now: () => mockNow,
    });

    const app = express();
    app.use(limiter);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);
    expect(res1.headers['x-ratelimit-limit']).toBe('3');
    expect(res1.headers['x-ratelimit-remaining']).toBe('2');

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('1');

    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(200);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('blocks requests exceeding the limit with HTTP 429 and Retry-After', async () => {
    let mockNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      now: () => mockNow,
    });

    const app = express();
    app.use(limiter);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    await request(app).get('/test'); // hit 1
    mockNow += 10_000;
    await request(app).get('/test'); // hit 2

    const blocked = await request(app).get('/test');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Too many requests');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBe(50);
  });

  it('resets counters after the time window expires', async () => {
    let mockNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 30_000,
      max: 1,
      now: () => mockNow,
    });

    const app = express();
    app.use(limiter);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);

    const blocked = await request(app).get('/test');
    expect(blocked.status).toBe(429);

    // Advance beyond window (30s)
    mockNow += 31_000;

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('supports skipping rate limiting for specific routes or predicates', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      skip: (req) => req.path === '/health',
    });

    const app = express();
    app.use(limiter);
    app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
    app.get('/api', (_req: Request, res: Response) => res.json({ ok: true }));

    await request(app).get('/health');
    await request(app).get('/health');
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    await request(app).get('/api');
    const api = await request(app).get('/api');
    expect(api.status).toBe(429);
  });

  it('enforces maxKeys eviction to bound memory against high-cardinality spoofing', async () => {
    let mockNow = 1_000_000;
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 5,
      maxKeys: 3, // only allow 3 active keys before evicting oldest
      keyGenerator: (req) => req.headers['x-client-id'] as string || 'default',
      now: () => mockNow,
    });

    const app = express();
    app.use(limiter);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    await request(app).get('/test').set('x-client-id', 'client-A');
    await request(app).get('/test').set('x-client-id', 'client-B');
    await request(app).get('/test').set('x-client-id', 'client-C');

    expect(limiter.getHitCount('client-A')).toBe(1);
    expect(limiter.getHitCount('client-B')).toBe(1);
    expect(limiter.getHitCount('client-C')).toBe(1);

    // 4th unique client causes client-A to be evicted
    await request(app).get('/test').set('x-client-id', 'client-D');
    expect(limiter.getHitCount('client-A')).toBe(0); // evicted!
    expect(limiter.getHitCount('client-D')).toBe(1);

    limiter.destroy();
  });

  it('supports handler.reset() and handler.getHitCount()', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      keyGenerator: () => 'fixed-key',
    });

    const app = express();
    app.use(limiter);
    app.get('/test', (_req: Request, res: Response) => res.json({ ok: true }));

    await request(app).get('/test');
    expect(limiter.getHitCount('fixed-key')).toBe(1);

    limiter.reset();
    expect(limiter.getHitCount('fixed-key')).toBe(0);

    limiter.destroy();
  });

  it('integrates rate limiting with createActionDispatchApp', async () => {
    const customLimiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
    });

    const app = createActionDispatchApp({
      databaseReady: async () => true,
      verifier: { verify: async () => ({} as any) },
      admission: { admit: async () => ({} as any) },
      resolveInstallationId: async () => 1234,
      rateLimiter: customLimiter,
    });

    // First call to /api/dispatch/action will be processed (returns 401 for missing bearer)
    const res1 = await request(app).post('/api/dispatch/action').send({});
    expect(res1.status).toBe(401);

    // Second call exceeds rate limit of 1
    const res2 = await request(app).post('/api/dispatch/action').send({});
    expect(res2.status).toBe(429);
    expect(res2.body.error).toContain('Too many requests');
    expect(res2.headers['retry-after']).toBeDefined();

    customLimiter.destroy();
  });
});
