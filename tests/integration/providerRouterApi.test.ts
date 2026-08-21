import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Writable } from 'stream';
import { createApp, providerPool } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

let testApiKey = '';

async function dispatchPost(app: any, path: string, body: any) {
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
    'x-api-key': testApiKey,
  };

  let responseData = '';
  const res: any = new Writable();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = String(v);
  };
  res.getHeader = (k: string) => res.headers[k.toLowerCase()];
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

describe('Provider Router API Integration Tests', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-12345';
    testApiKey = dashboardStore.createApiKey('provider-test-key').rawKey;
    app = createApp();
  });

  beforeEach(() => {
    providerPool.clear();
  });

  describe('POST /api/router/providers', () => {
    it('registers a new provider and returns HTTP 201 Created with JSON metadata', async () => {
      const payload = {
        id: 'openai-dynamic',
        type: 'openai',
        apiKey: 'sk-proj-dynamic-key-12345',
        baseUrl: 'https://api.openai.com/v1',
        models: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
      };

      const response = await dispatchPost(app, '/api/router/providers', payload);

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        success: true,
        provider: {
          id: 'openai-dynamic',
          type: 'openai',
          models: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
        },
      });

      // Verify runtime registration in providerPool without container restarts
      expect(providerPool.hasProvider('openai-dynamic')).toBe(true);
      const registered = providerPool.getProvider('openai-dynamic');
      expect(registered?.apiKey).toBe('sk-proj-dynamic-key-12345');
      expect(registered?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('rejects duplicate provider registration with HTTP 400 Bad Request', async () => {
      const payload = {
        id: 'duplicate-provider',
        type: 'anthropic',
        apiKey: 'sk-ant-123',
        models: ['claude-3-5-sonnet-20240620'],
      };

      // First request succeeds
      const res1 = await dispatchPost(app, '/api/router/providers', payload);
      expect(res1.status).toBe(201);

      // Second request with duplicate id fails with 400
      const res2 = await dispatchPost(app, '/api/router/providers', payload);

      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toMatch(/already registered/i);
    });

    it('rejects invalid schema payload with HTTP 400 Bad Request', async () => {
      const invalidPayload = {
        id: 'bad-provider',
        // missing type, apiKey, and models
      };

      const response = await dispatchPost(app, '/api/router/providers', invalidPayload);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });
  });
});
