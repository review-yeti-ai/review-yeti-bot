import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Writable } from 'stream';
import { createApp, providerPool } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

async function dispatchPost(app: any, path: string, body: any) {
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
  };

  let responseData = '';
  const res: any = new Writable();
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
    responseData = JSON.stringify(data);
    res.end();
  };
  res.write = (chunk: any) => {
    responseData += chunk.toString();
    return true;
  };

  return new Promise<{ status: number; body: any }>((resolve) => {
    res.end = (chunk?: any) => {
      if (chunk) responseData += chunk.toString();
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

describe('Milestone 5 ProviderPool & Router API Empirical Stress Test Harness', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-12345';
    app = createApp();
  });

  beforeEach(() => {
    providerPool.clear();
  });

  describe('1. Dynamic Model Registration Without Container Restart', () => {
    it('registers dynamic provider via POST /api/router/providers and reflects in pool immediately', async () => {
      const payload = {
        id: 'dynamic-openai-v1',
        type: 'openai',
        apiKey: 'sk-live-secret-key-999',
        baseUrl: 'https://custom-proxy.internal/v1',
        models: ['gpt-4o-2024-08-06', 'o3-mini-preview'],
      };

      const res = await dispatchPost(app, '/api/router/providers', payload);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        success: true,
        provider: {
          id: 'dynamic-openai-v1',
          type: 'openai',
          models: ['gpt-4o-2024-08-06', 'o3-mini-preview'],
        },
      });

      // Assert apiKey is NOT exposed in HTTP response payload
      expect(res.body.provider.apiKey).toBeUndefined();

      // Assert instant runtime availability without restart
      expect(providerPool.hasProvider('dynamic-openai-v1')).toBe(true);
      const retrieved = providerPool.getProvider('dynamic-openai-v1');
      expect(retrieved?.apiKey).toBe('sk-live-secret-key-999');
      expect(retrieved?.baseUrl).toBe('https://custom-proxy.internal/v1');

      // Assert model lookups
      expect(providerPool.isModelAllowed('dynamic-openai-v1', 'gpt-4o-2024-08-06')).toBe(true);
      expect(providerPool.isModelAllowed('dynamic-openai-v1', 'o3-mini-preview')).toBe(true);
      expect(providerPool.isModelAllowed('dynamic-openai-v1', 'unregistered-model')).toBe(false);
    });

    it('dynamically registers multiple distinct providers sequentially', async () => {
      const providers = [
        { id: 'prov-1', type: 'openai', apiKey: 'key-1', models: ['m1', 'm2'] },
        { id: 'prov-2', type: 'anthropic', apiKey: 'key-2', models: ['m3'] },
        { id: 'prov-3', type: 'ollama', apiKey: 'key-3', baseUrl: 'http://localhost:11434', models: ['llama3:8b'] },
      ];

      for (const p of providers) {
        const res = await dispatchPost(app, '/api/router/providers', p);
        expect(res.status).toBe(201);
      }

      expect(providerPool.listProviders()).toHaveLength(3);
      expect(providerPool.hasProvider('prov-1')).toBe(true);
      expect(providerPool.hasProvider('prov-2')).toBe(true);
      expect(providerPool.hasProvider('prov-3')).toBe(true);
    });
  });

  describe('2. Malformed Payload Rejection (HTTP 400 Bad Request)', () => {
    it('rejects payload with missing id', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        type: 'openai',
        apiKey: 'key',
        models: ['m1'],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('rejects payload with empty string id', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: '',
        type: 'openai',
        apiKey: 'key',
        models: ['m1'],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects payload with missing type', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 'p1',
        apiKey: 'key',
        models: ['m1'],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects payload with missing apiKey', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 'p1',
        type: 'openai',
        apiKey: '',
        models: ['m1'],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects payload with empty models array', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 'p1',
        type: 'openai',
        apiKey: 'key',
        models: [],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects payload with empty string inside models array', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 'p1',
        type: 'openai',
        apiKey: 'key',
        models: [''],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects non-array models field', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 'p1',
        type: 'openai',
        apiKey: 'key',
        models: 'gpt-4o',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects empty object payload', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects numeric or boolean invalid field types', async () => {
      const res = await dispatchPost(app, '/api/router/providers', {
        id: 12345,
        type: true,
        apiKey: null,
        models: [123],
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('3. Duplicate Provider Handling & Update Workflow', () => {
    it('rejects duplicate registration attempt with HTTP 400 Bad Request', async () => {
      const payload = {
        id: 'dup-id',
        type: 'openai',
        apiKey: 'key-v1',
        models: ['gpt-4o'],
      };

      const res1 = await dispatchPost(app, '/api/router/providers', payload);
      expect(res1.status).toBe(201);

      const res2 = await dispatchPost(app, '/api/router/providers', payload);
      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toContain("Provider with id 'dup-id' is already registered");
    });

    it('supports updating provider configuration via removeProvider + re-registration', async () => {
      const initialPayload = {
        id: 'updatable-prov',
        type: 'openai',
        apiKey: 'key-v1',
        models: ['gpt-4o'],
      };

      const resInit = await dispatchPost(app, '/api/router/providers', initialPayload);
      expect(resInit.status).toBe(201);
      expect(providerPool.isModelAllowed('updatable-prov', 'gpt-4o')).toBe(true);
      expect(providerPool.isModelAllowed('updatable-prov', 'gpt-4o-mini')).toBe(false);

      // Remove existing provider
      const removed = providerPool.removeProvider('updatable-prov');
      expect(removed).toBe(true);

      // Re-register updated provider configuration
      const updatedPayload = {
        id: 'updatable-prov',
        type: 'openai',
        apiKey: 'key-v2-updated',
        models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview'],
      };

      const resUpdate = await dispatchPost(app, '/api/router/providers', updatedPayload);
      expect(resUpdate.status).toBe(201);

      // Verify updated model list and API key immediately active
      expect(providerPool.getProvider('updatable-prov')?.apiKey).toBe('key-v2-updated');
      expect(providerPool.isModelAllowed('updatable-prov', 'gpt-4o-mini')).toBe(true);
      expect(providerPool.isModelAllowed('updatable-prov', 'o1-preview')).toBe(true);
    });
  });

  describe('4. Model Allowlisting & Lookup Verification', () => {
    beforeEach(async () => {
      await dispatchPost(app, '/api/router/providers', {
        id: 'complex-models-prov',
        type: 'custom',
        apiKey: 'secret-key',
        models: [
          'anthropic/claude-3-5-sonnet:v1',
          'local-llama-3.1-405b-instruct@q4_k_m',
          'vendor.subvendor/model-name_v2.0',
        ],
      });
    });

    it('correctly matches complex model identifiers', () => {
      expect(providerPool.isModelAllowed('complex-models-prov', 'anthropic/claude-3-5-sonnet:v1')).toBe(true);
      expect(providerPool.isModelAllowed('complex-models-prov', 'local-llama-3.1-405b-instruct@q4_k_m')).toBe(true);
      expect(providerPool.isModelAllowed('complex-models-prov', 'vendor.subvendor/model-name_v2.0')).toBe(true);
    });

    it('returns false for unlisted models on registered provider', () => {
      expect(providerPool.isModelAllowed('complex-models-prov', 'anthropic/claude-3-5-sonnet')).toBe(false);
      expect(providerPool.isModelAllowed('complex-models-prov', 'random-model')).toBe(false);
    });

    it('returns false for non-existent provider ID', () => {
      expect(providerPool.isModelAllowed('ghost-provider', 'anthropic/claude-3-5-sonnet:v1')).toBe(false);
    });
  });

  describe('5. High-Volume Concurrent Stress Test Harness', () => {
    it('handles 100 concurrent dynamic provider registrations and 1,000 parallel lookups', async () => {
      const totalProviders = 100;
      const registrationPromises = [];

      for (let i = 0; i < totalProviders; i++) {
        const payload = {
          id: `stress-prov-${i}`,
          type: i % 2 === 0 ? 'openai' : 'anthropic',
          apiKey: `key-stress-${i}`,
          models: [`model-a-${i}`, `model-b-${i}`],
        };
        registrationPromises.push(dispatchPost(app, '/api/router/providers', payload));
      }

      const results = await Promise.all(registrationPromises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      expect(providerPool.listProviders()).toHaveLength(totalProviders);

      // Perform 1,000 parallel model lookups
      const lookupCount = 1000;
      let validCount = 0;

      for (let k = 0; k < lookupCount; k++) {
        const provIdx = k % totalProviders;
        const isAllowed = providerPool.isModelAllowed(`stress-prov-${provIdx}`, `model-a-${provIdx}`);
        if (isAllowed) validCount++;
      }

      expect(validCount).toBe(lookupCount);

      // Clean up and verify pool reset
      providerPool.clear();
      expect(providerPool.listProviders()).toHaveLength(0);
    });
  });
});
