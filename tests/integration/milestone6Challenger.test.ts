import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Writable } from 'stream';
import { createApp, providerPool } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

async function dispatchPost(app: any, path: string, body: any, customHeaders?: Record<string, string>) {
  const session = authService.login('admin', 'admin123');
  const socket: any = new EventEmitter();
  socket.readable = true;
  socket.readableHighWaterMark = 16 * 1024;
  socket.destroyed = false;
  socket.destroy = (error?: Error) => {
    socket.destroyed = true;
    socket.emit('close', error);
    return socket;
  };
  socket.setTimeout = () => socket;
  const req: any = new IncomingMessage(socket);
  req._read = () => {};
  req.complete = true;
  req.method = 'POST';
  req.url = path;

  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const bodyBuffer = Buffer.from(rawBody);
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(bodyBuffer.length),
    'authorization': `Bearer ${session?.token}`,
    ...customHeaders,
  };

  let responseData = '';
  const res: any = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk) responseData += chunk.toString();
      callback();
    },
  });
  res.statusCode = 200;
  res.headers = {};
  res._headers = res.headers;
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = String(v);
  };
  res.getHeader = (k: string) => res.headers[k.toLowerCase()];
  res.removeHeader = (k: string) => {
    delete res.headers[k.toLowerCase()];
  };
  res.hasHeader = (k: string) => Boolean(res.headers[k.toLowerCase()]);
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(data));
  };

  return new Promise<{ status: number; body: any }>((resolve) => {
    const originalEnd = res.end.bind(res);
    res.end = (chunk?: any, encoding?: any, cb?: any) => {
      if (chunk && typeof chunk !== 'function') {
        responseData += chunk.toString();
      }
      originalEnd();
      let parsed = responseData;
      try {
        parsed = JSON.parse(responseData);
      } catch {}
      resolve({ status: res.statusCode, body: parsed });
    };

    app(req, res);
    setImmediate(() => {
      req.complete = true;
      req.push(bodyBuffer);
      req.push(null);
    });
  });
}

describe('Milestone 6 Challenger: Dynamic Provider & Live Router Stress Test Harness', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-m6';
    app = createApp();
  });

  beforeEach(() => {
    providerPool.clear();
  });

  describe('1. POST /api/router/providers Live Router Endpoint Stress Tests', () => {
    it('registers a valid dynamic provider, returns 201, and omits sensitive apiKey in response', async () => {
      const payload = {
        id: 'm6-provider-1',
        type: 'openai-compatible',
        apiKey: 'super-secret-key-999',
        baseUrl: 'https://router.internal/v1',
        models: ['gpt-4o', 'claude-3-5-sonnet', 'deepseek-r1'],
      };

      const res = await dispatchPost(app, '/api/router/providers', payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.provider).toEqual({
        id: 'm6-provider-1',
        type: 'openai-compatible',
        models: ['gpt-4o', 'claude-3-5-sonnet', 'deepseek-r1'],
      });
      // Verification of zero secret leakage in API response
      expect((res.body.provider as any).apiKey).toBeUndefined();

      // Immediate runtime state reflection check
      expect(providerPool.hasProvider('m6-provider-1')).toBe(true);
      const stored = providerPool.getProvider('m6-provider-1');
      expect(stored?.apiKey).toBe('super-secret-key-999');
      expect(stored?.baseUrl).toBe('https://router.internal/v1');
    });

    it('rejects duplicate provider registration with HTTP 400 Bad Request', async () => {
      const payload = {
        id: 'm6-duplicate-id',
        type: 'anthropic',
        apiKey: 'sk-ant-test',
        models: ['claude-3-5-sonnet'],
      };

      const res1 = await dispatchPost(app, '/api/router/providers', payload);
      expect(res1.status).toBe(201);

      const res2 = await dispatchPost(app, '/api/router/providers', payload);
      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toContain("Provider with id 'm6-duplicate-id' is already registered");
    });

    it('rejects missing required fields (id, type, apiKey, models) with HTTP 400', async () => {
      const cases = [
        { name: 'missing id', payload: { type: 'openai', apiKey: 'k', models: ['m1'] } },
        { name: 'empty id string', payload: { id: '', type: 'openai', apiKey: 'k', models: ['m1'] } },
        { name: 'missing type', payload: { id: 'p', apiKey: 'k', models: ['m1'] } },
        { name: 'empty type string', payload: { id: 'p', type: '', apiKey: 'k', models: ['m1'] } },
        { name: 'missing apiKey', payload: { id: 'p', type: 'openai', models: ['m1'] } },
        { name: 'empty apiKey string', payload: { id: 'p', type: 'openai', apiKey: '', models: ['m1'] } },
        { name: 'missing models', payload: { id: 'p', type: 'openai', apiKey: 'k' } },
        { name: 'empty models array', payload: { id: 'p', type: 'openai', apiKey: 'k', models: [] } },
        { name: 'models with empty string', payload: { id: 'p', type: 'openai', apiKey: 'k', models: [''] } },
      ];

      for (const c of cases) {
        const res = await dispatchPost(app, '/api/router/providers', c.payload);
        expect(res.status, `Failed case: ${c.name}`).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBeDefined();
      }
    });

    it('rejects malformed payload types (primitives, null, arrays, wrong type values) with HTTP 400', async () => {
      const invalidTypes = [
        null,
        12345,
        'just a string',
        true,
        ['array', 'payload'],
        { id: 123, type: 'openai', apiKey: 'k', models: ['m1'] },
        { id: 'p', type: true, apiKey: 'k', models: ['m1'] },
        { id: 'p', type: 'openai', apiKey: null, models: ['m1'] },
        { id: 'p', type: 'openai', apiKey: 'k', models: 'not-an-array' },
        { id: 'p', type: 'openai', apiKey: 'k', models: [100, 200] },
      ];

      for (const payload of invalidTypes) {
        const res = await dispatchPost(app, '/api/router/providers', payload);
        expect(res.status).toBe(400);
        expect(res.body).toBeDefined();
      }
    });

    it('handles large payloads (1,000 models, long strings) without crash or truncation', async () => {
      const thousandModels = Array.from({ length: 1000 }, (_, i) => `model-stress-v${i}`);
      const longApiKey = 'sk-long-' + 'x'.repeat(5000);

      const payload = {
        id: 'large-provider',
        type: 'stress-tester',
        apiKey: longApiKey,
        models: thousandModels,
      };

      const res = await dispatchPost(app, '/api/router/providers', payload);
      expect(res.status).toBe(201);
      expect(res.body.provider.models).toHaveLength(1000);

      expect(providerPool.hasProvider('large-provider')).toBe(true);
      expect(providerPool.isModelAllowed('large-provider', 'model-stress-v999')).toBe(true);
      expect(providerPool.getProvider('large-provider')?.apiKey).toBe(longApiKey);
    });

    it('gracefully handles special characters and unicode in provider fields', async () => {
      const payload = {
        id: 'prov-🚀-unicode-!@#$%^&*()',
        type: 'custom-type/v1',
        apiKey: 'key-with-symbols-!#$',
        baseUrl: 'https://proxy.internal:8443/v1?arg=val',
        models: ['org/model-name:v1.2@sha256:abc', 'llama-3.1:70b-instruct-q4_K_M'],
      };

      const res = await dispatchPost(app, '/api/router/providers', payload);
      expect(res.status).toBe(201);

      expect(providerPool.hasProvider('prov-🚀-unicode-!@#$%^&*()')).toBe(true);
      expect(providerPool.isModelAllowed('prov-🚀-unicode-!@#$%^&*()', 'org/model-name:v1.2@sha256:abc')).toBe(true);
    });
  });

  describe('2. ProviderPool Dynamic State Management & Lifecycle', () => {
    it('supports runtime removal and re-registration (provider update workflow)', () => {
      const p1 = {
        id: 'updatable-provider',
        type: 'openai',
        apiKey: 'key-v1',
        models: ['gpt-4o'],
      };

      providerPool.registerProvider(p1);
      expect(providerPool.isModelAllowed('updatable-provider', 'gpt-4o')).toBe(true);
      expect(providerPool.isModelAllowed('updatable-provider', 'gpt-4o-mini')).toBe(false);

      // Remove provider
      const removed = providerPool.removeProvider('updatable-provider');
      expect(removed).toBe(true);
      expect(providerPool.hasProvider('updatable-provider')).toBe(false);
      expect(providerPool.isModelAllowed('updatable-provider', 'gpt-4o')).toBe(false);

      // Re-register with updated config
      const p2 = {
        id: 'updatable-provider',
        type: 'openai',
        apiKey: 'key-v2',
        models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
      };

      providerPool.registerProvider(p2);
      expect(providerPool.getProvider('updatable-provider')?.apiKey).toBe('key-v2');
      expect(providerPool.isModelAllowed('updatable-provider', 'gpt-4o-mini')).toBe(true);
      expect(providerPool.isModelAllowed('updatable-provider', 'o3-mini')).toBe(true);
    });

    it('returns false for removeProvider when provider ID does not exist', () => {
      expect(providerPool.removeProvider('non-existent')).toBe(false);
    });

    it('strictly checks model allowlisting (case sensitivity & exact string matching)', () => {
      providerPool.registerProvider({
        id: 'case-test-prov',
        type: 'test',
        apiKey: 'key',
        models: ['gpt-4o', 'Claude-3-5-Sonnet'],
      });

      expect(providerPool.isModelAllowed('case-test-prov', 'gpt-4o')).toBe(true);
      expect(providerPool.isModelAllowed('case-test-prov', 'GPT-4O')).toBe(false);
      expect(providerPool.isModelAllowed('case-test-prov', 'Claude-3-5-Sonnet')).toBe(true);
      expect(providerPool.isModelAllowed('case-test-prov', 'claude-3-5-sonnet')).toBe(false);
      expect(providerPool.isModelAllowed('case-test-prov', '')).toBe(false);
      expect(providerPool.isModelAllowed('unknown-prov', 'gpt-4o')).toBe(false);
    });

    it('atomic state cleanups via clear() wipe all registrations', () => {
      providerPool.registerProvider({ id: 'p1', type: 't', apiKey: 'k', models: ['m1'] });
      providerPool.registerProvider({ id: 'p2', type: 't', apiKey: 'k', models: ['m2'] });

      expect(providerPool.listProviders()).toHaveLength(2);
      providerPool.clear();
      expect(providerPool.listProviders()).toHaveLength(0);
      expect(providerPool.hasProvider('p1')).toBe(false);
    });
  });

  describe('3. High-Volume Parallel Concurrency & Race Conditions', () => {
    it('handles concurrent registration of 50 providers with interleaved lookups and removals', async () => {
      const count = 50;
      const promises = Array.from({ length: count }, (_, i) =>
        dispatchPost(app, '/api/router/providers', {
          id: `conc-prov-${i}`,
          type: 'openai',
          apiKey: `key-${i}`,
          models: [`model-${i}-a`, `model-${i}-b`],
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      expect(providerPool.listProviders()).toHaveLength(count);

      // Perform 500 parallel model lookups
      const lookupPromises = Array.from({ length: 500 }, (_, i) => {
        const idx = i % count;
        return providerPool.isModelAllowed(`conc-prov-${idx}`, `model-${idx}-a`);
      });

      const lookupResults = await Promise.all(lookupPromises);
      expect(lookupResults.every(Boolean)).toBe(true);

      // Interleaved removal of even-indexed providers
      for (let i = 0; i < count; i += 2) {
        providerPool.removeProvider(`conc-prov-${i}`);
      }

      expect(providerPool.listProviders()).toHaveLength(25);
      expect(providerPool.hasProvider('conc-prov-0')).toBe(false);
      expect(providerPool.hasProvider('conc-prov-1')).toBe(true);
    });
  });
});
