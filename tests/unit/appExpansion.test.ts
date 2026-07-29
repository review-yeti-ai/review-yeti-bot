import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Readable, Writable } from 'stream';
import { createApp, providerPool } from '../../src/app';

async function dispatchGet(app: any, path: string) {
  const req: any = new Readable();
  req._read = () => {};
  req.method = 'GET';
  req.url = path;
  req.headers = {};

  let responseData = '';
  const res: any = new Writable();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = String(v); };
  res.getHeader = (k: string) => res.headers[k.toLowerCase()];
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (data: any) => {
    res.setHeader('content-type', 'application/json');
    responseData = JSON.stringify(data);
    res.end();
  };
  res.write = (chunk: any) => { responseData += chunk.toString(); return true; };

  return new Promise<{ status: number; body: any }>((resolve) => {
    res.end = (chunk?: any) => {
      if (chunk) responseData += chunk.toString();
      let parsed = responseData;
      try { parsed = JSON.parse(responseData); } catch {}
      resolve({ status: res.statusCode, body: parsed });
    };

    app(req, res);
    setImmediate(() => { req.push(null); });
  });
}

describe('app.ts — Comprehensive Unit Expansion Tests', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    providerPool.clear();
    app = createApp();
  });

  it('createApp returns an Express app function handler', () => {
    expect(typeof app).toBe('function');
  });

  it('GET /health returns HTTP 200 with service metadata', async () => {
    const res = await dispatchGet(app, '/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('ct-review-bot');
    expect(res.body.timestamp).toBeDefined();
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('GET /ready returns HTTP 200 with configurationReady false when required environment variables are missing', async () => {
    const originalId = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_ID;

    const res = await dispatchGet(app, '/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.configurationReady).toBe(false);

    process.env.GITHUB_APP_ID = originalId;
  });
});
