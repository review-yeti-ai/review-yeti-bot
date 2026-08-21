import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Readable, Writable } from 'stream';
import { createApp, providerPool } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

async function dispatchPost(app: any, path: string, body: any, headers: Record<string, string> = {}) {
  const session = authService.login('admin', 'admin123');
  const req: any = new Readable();
  req._read = () => {};
  req.method = 'POST';
  req.url = path;

  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const bodyBuffer = Buffer.from(rawBody);
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(bodyBuffer.length),
    'authorization': `Bearer ${session?.token}`,
    ...headers,
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
      req.push(bodyBuffer);
      req.push(null);
    });
  });
}

describe('Live Router Integration — Dynamic Model Addition & ProviderPool', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-12345';
    process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || 'test-private-key';
    process.env.OMNIROUTE_BASE_URL = process.env.OMNIROUTE_BASE_URL || 'http://localhost:8080';
    app = createApp();
  });

  beforeEach(() => {
    providerPool.clear();
  });

  it('registers a new provider configuration with HTTP 201 Created and correct JSON body', async () => {
    const payload = {
      id: 'anthropic-dynamic',
      type: 'anthropic',
      apiKey: 'sk-ant-api03-dynamic-token-999',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-5-sonnet', 'claude-3-5-sonnet-20240620'],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      provider: {
        id: 'anthropic-dynamic',
        type: 'anthropic',
        models: ['claude-5-sonnet', 'claude-3-5-sonnet-20240620'],
      },
    });

    // Lookup in ProviderPool
    expect(providerPool.hasProvider('anthropic-dynamic')).toBe(true);
    const stored = providerPool.getProvider('anthropic-dynamic');
    expect(stored?.apiKey).toBe('sk-ant-api03-dynamic-token-999');
    expect(stored?.baseUrl).toBe('https://api.anthropic.com');
  });

  it('allows registering models from R4 allowed set (gpt-5.6-sol, deepseek-v4-pro, glm-5.2)', async () => {
    const payload = {
      id: 'r4-multi-provider',
      type: 'openai-compatible',
      apiKey: 'sk-r4-key-123',
      models: ['gpt-5.6-sol', 'deepseek-v4-pro', 'glm-5.2'],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(201);

    expect(providerPool.isModelAllowed('r4-multi-provider', 'gpt-5.6-sol')).toBe(true);
    expect(providerPool.isModelAllowed('r4-multi-provider', 'deepseek-v4-pro')).toBe(true);
    expect(providerPool.isModelAllowed('r4-multi-provider', 'glm-5.2')).toBe(true);
    expect(providerPool.isModelAllowed('r4-multi-provider', 'non-existent-model')).toBe(false);
  });

  it('rejects duplicate provider registration with HTTP 400 Bad Request', async () => {
    const payload = {
      id: 'dup-check-provider',
      type: 'custom',
      apiKey: 'key-123',
      models: ['model-a'],
    };

    const firstRes = await dispatchPost(app, '/api/router/providers', payload);
    expect(firstRes.status).toBe(201);

    const dupRes = await dispatchPost(app, '/api/router/providers', payload);
    expect(dupRes.status).toBe(400);
    expect(dupRes.body.success).toBe(false);
    expect(dupRes.body.error).toContain("already registered");
  });

  it('rejects malformed payload missing provider id with HTTP 400', async () => {
    const payload = {
      type: 'openai',
      apiKey: 'sk-123',
      models: ['gpt-4o'],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload missing type with HTTP 400', async () => {
    const payload = {
      id: 'no-type',
      apiKey: 'sk-123',
      models: ['gpt-4o'],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload missing apiKey with HTTP 400', async () => {
    const payload = {
      id: 'no-key',
      type: 'openai',
      models: ['gpt-4o'],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload with empty models array with HTTP 400', async () => {
    const payload = {
      id: 'empty-models',
      type: 'openai',
      apiKey: 'sk-123',
      models: [],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload with non-array models field with HTTP 400', async () => {
    const payload = {
      id: 'string-models',
      type: 'openai',
      apiKey: 'sk-123',
      models: 'gpt-4o',
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload with empty string in models array with HTTP 400', async () => {
    const payload = {
      id: 'invalid-model-item',
      type: 'openai',
      apiKey: 'sk-123',
      models: ['gpt-4o', ''],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects malformed payload with invalid numeric and boolean field types', async () => {
    const payload = {
      id: 12345,
      type: true,
      apiKey: null,
      models: [100, 200],
    };

    const res = await dispatchPost(app, '/api/router/providers', payload);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('supports runtime listProviders reflection after dynamic registration', async () => {
    expect(providerPool.listProviders()).toHaveLength(0);

    await dispatchPost(app, '/api/router/providers', {
      id: 'p1',
      type: 't1',
      apiKey: 'k1',
      models: ['m1'],
    });

    await dispatchPost(app, '/api/router/providers', {
      id: 'p2',
      type: 't2',
      apiKey: 'k2',
      models: ['m2', 'm3'],
    });

    const list = providerPool.listProviders();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('supports runtime provider removal and verifies hasProvider returns false', async () => {
    await dispatchPost(app, '/api/router/providers', {
      id: 'temp-p',
      type: 'temp',
      apiKey: 'ktemp',
      models: ['mtemp'],
    });

    expect(providerPool.hasProvider('temp-p')).toBe(true);
    const removed = providerPool.removeProvider('temp-p');
    expect(removed).toBe(true);
    expect(providerPool.hasProvider('temp-p')).toBe(false);
    expect(providerPool.getProvider('temp-p')).toBeUndefined();
  });

  it('handles optional baseUrl correctly when present and omitted', async () => {
    await dispatchPost(app, '/api/router/providers', {
      id: 'with-base-url',
      type: 'custom',
      apiKey: 'k1',
      baseUrl: 'https://custom.api.endpoint/v1',
      models: ['m1'],
    });

    await dispatchPost(app, '/api/router/providers', {
      id: 'without-base-url',
      type: 'custom',
      apiKey: 'k2',
      models: ['m2'],
    });

    expect(providerPool.getProvider('with-base-url')?.baseUrl).toBe('https://custom.api.endpoint/v1');
    expect(providerPool.getProvider('without-base-url')?.baseUrl).toBeUndefined();
  });

  it('verifies provider pool clear removes all dynamically added providers', async () => {
    await dispatchPost(app, '/api/router/providers', {
      id: 'clear-1',
      type: 'type-1',
      apiKey: 'key-1',
      models: ['model-1'],
    });

    expect(providerPool.listProviders()).toHaveLength(1);
    providerPool.clear();
    expect(providerPool.listProviders()).toHaveLength(0);
  });
});
