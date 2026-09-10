import { describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createRateLimiter, getClientIp } from '../../src/security/rateLimiter';

describe('createRateLimiter Express middleware', () => {
  it('extracts client IP properly from X-Forwarded-For', () => {
    const req1 = { headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' } } as unknown as Request;
    expect(getClientIp(req1)).toBe('203.0.113.195');

    const req2 = { headers: { 'x-forwarded-for': ['198.51.100.22', '10.0.0.1'] } } as unknown as Request;
    expect(getClientIp(req2)).toBe('198.51.100.22');

    const req3 = { headers: {}, socket: { remoteAddress: '192.0.2.1' } } as unknown as Request;
    expect(getClientIp(req3)).toBe('192.0.2.1');
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

    // 3rd hit at t = 1_010_000 (exceeds limit of 2 in 60s window)
    const blocked = await request(app).get('/test');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain('Too many requests');
    expect(blocked.headers['retry-after']).toBeDefined();
    // First hit was at 1_000_000, resets at 1_060_000.
    // At 1_010_000, retry-after = (1_060_000 - 1_010_000) / 1000 = 50s
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

    // /health is never throttled
    await request(app).get('/health');
    await request(app).get('/health');
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    // /api is throttled after 1
    await request(app).get('/api');
    const api = await request(app).get('/api');
    expect(api.status).toBe(429);
  });
});
