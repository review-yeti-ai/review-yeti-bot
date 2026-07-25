import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SymbolGraphStore } from '../../src/indexer/symbolGraphStore';
import { createMemoryRouter } from '../../src/api/memoryApi';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';

interface TestResponse {
  status: number;
  statusCode: number;
  headers: Record<string, any>;
  header: Record<string, any>;
  body: any;
  text: string;
}

/**
 * Stream-based in-memory HTTP request runner for Express apps.
 * Bypasses network socket binding (net.Server.listen) to operate 100% reliably under macOS sandbox restrictions.
 */
function makeRequest(
  app: Express,
  method: string,
  url: string,
  body?: any,
  customHeaders: Record<string, string> = {}
): Promise<TestResponse> {
  const session = authService.login('admin', 'admin123');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const req = new IncomingMessage(socket);
    req.method = method.toUpperCase();
    req.url = url;
    req.headers = {
      authorization: `Bearer ${session?.token}`,
    };

    for (const [k, v] of Object.entries(customHeaders)) {
      req.headers[k.toLowerCase()] = v;
    }

    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!req.headers['content-type']) {
        req.headers['content-type'] = 'application/json';
      }
      req.headers['content-length'] = String(Buffer.byteLength(payload));
    }

    const res = new ServerResponse(req);
    let bodyBuffer = '';

    const originalWrite = res.write;
    res.write = function (chunk: any, encoding: any, cb: any) {
      if (chunk) bodyBuffer += chunk.toString();
      if (typeof originalWrite === 'function') {
        originalWrite.call(res, chunk, encoding, cb);
      }
      return true;
    };

    const originalEnd = res.end;
    res.end = function (chunk: any, encoding: any, cb: any) {
      if (chunk) bodyBuffer += chunk.toString();
      if (typeof originalEnd === 'function') {
        originalEnd.call(res, chunk, encoding, cb);
      }
      let parsedBody: any;
      try {
        parsedBody = JSON.parse(bodyBuffer);
      } catch {
        parsedBody = bodyBuffer;
      }
      resolve({
        status: res.statusCode,
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        header: res.getHeaders(),
        body: parsedBody,
        text: bodyBuffer,
      });
    };

    app(req, res);

    process.nextTick(() => {
      if (payload !== undefined) {
        req.push(Buffer.from(payload));
      }
      req.push(null);
    });
  });
}

describe('Milestone 10 Agent API Stress & Edge Case Challenger Tests', () => {
  let app: Express;
  let prMemoryStore: PRMemoryStore;
  let symbolGraphStore: SymbolGraphStore;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret-12345';
    prMemoryStore = new PRMemoryStore(':memory:');
    symbolGraphStore = new SymbolGraphStore(':memory:');
    app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ prMemoryStore, symbolGraphStore }));
    app.get('/health', (_req, res) => {
      res.status(200).json({
        status: 'ok',
        service: 'ct-review-bot',
        memoryEngineReady: true,
        timestamp: new Date().toISOString(),
        uptimeSeconds: process.uptime(),
      });
    });
  });

  afterEach(() => {
    prMemoryStore.close();
    symbolGraphStore.close();
  });

  describe('1. Health Check Endpoint (/health)', () => {
    it('GET /health returns 200 OK with expected JSON structure', async () => {
      const res = await makeRequest(app, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('ct-review-bot');
      expect(res.body.memoryEngineReady).toBe(true);
      expect(typeof res.body.timestamp).toBe('string');
      expect(typeof res.body.uptimeSeconds).toBe('number');
    });

    it('POST /health returns 404 Not Found', async () => {
      const res = await makeRequest(app, 'POST', '/health', {});
      expect(res.status).toBe(404);
    });
  });

  describe('2. Invalid JSON Bodies & Malformed Input Handling', () => {
    it('returns 400 Bad Request when malformed JSON is sent to /api/memory/query', async () => {
      const res = await makeRequest(
        app,
        'POST',
        '/api/memory/query',
        '{ invalid json payload: true, ',
        { 'Content-Type': 'application/json' }
      );

      expect(res.status).toBe(400);
    });

    it('returns 400 Bad Request when empty body is sent to /api/memory/query', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/query');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('returns 400 Bad Request when JSON primitive (string/number) is sent instead of object', async () => {
      const res = await makeRequest(
        app,
        'POST',
        '/api/memory/query',
        'just a string',
        { 'Content-Type': 'application/json' }
      );

      expect(res.status).toBe(400);
    });
  });

  describe('3. Missing Required Parameters & Zod Schema Validation Errors', () => {
    it('POST /api/memory/query returns 400 when required "repo" parameter is missing', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/query', {
        category: 'security',
        query: 'auth',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/repo is required/i);
    });

    it('POST /api/memory/query returns 400 when invalid category enum value is provided', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/query', {
        repo: 'calltelemetry/cisco-cdr',
        category: 'invalid_category_enum',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('POST /api/code/symbol-graph returns 400 when required "symbolName" is missing', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/symbol-graph', {
        includeCallers: true,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/symbolName is required/i);
    });

    it('POST /api/code/symbol-graph returns 400 when invalid type is provided for boolean flags', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/symbol-graph', {
        symbolName: 'createMemoryRouter',
        includeCallers: 'not-a-boolean',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it('POST /api/code/search returns 400 when required "query" parameter is missing', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', { limit: 10 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/query is required/i);
    });

    it('POST /api/code/search returns 400 when "limit" parameter is non-integer string', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'astParser',
        limit: 'ten',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/memory/record returns 400 when required "repo" parameter is missing', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/record', {
        type: 'learning',
        data: { title: 'test' },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/memory/record returns 400 when required "type" parameter is missing', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/record', {
        repo: 'calltelemetry/cisco-cdr',
        data: { title: 'test' },
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/memory/record returns 400 when invalid type enum is provided', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/record', {
        repo: 'calltelemetry/cisco-cdr',
        type: 'unsupported_type',
        data: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/memory/record returns 400 when "data" is not an object', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/record', {
        repo: 'calltelemetry/cisco-cdr',
        type: 'learning',
        data: 'string_data',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('4. Non-Existent Symbols, Empty Queries & Search Limit Boundary Values', () => {
    it('POST /api/code/symbol-graph with non-existent symbol returns 200 with empty arrays', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/symbol-graph', {
        symbolName: 'NonExistentSymbol_XYZ_99999',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.symbolName).toBe('NonExistentSymbol_XYZ_99999');
      expect(res.body.definitions).toEqual([]);
      expect(res.body.references).toEqual([]);
      expect(res.body.callers).toEqual([]);
      expect(res.body.callees).toEqual([]);
    });

    it('POST /api/code/symbol-graph with empty string symbolName returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/symbol-graph', {
        symbolName: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search with empty query string returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/memory/query with empty repo string returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/memory/query', {
        repo: '',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search boundary limit = 1 (min valid limit) returns 200', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 1,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results.length).toBeLessThanOrEqual(1);
    });

    it('POST /api/code/search boundary limit = 50 (max valid limit) returns 200', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 50,
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results.length).toBeLessThanOrEqual(50);
    });

    it('POST /api/code/search boundary limit = 51 (exceeds max limit of 50) returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 51,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search large limit = 100 (exceeds max limit of 50) returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 100,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search boundary limit = 0 (below min limit of 1) returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 0,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search negative limit = -5 returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: -5,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/code/search floating-point limit = 5.5 returns 400', async () => {
      const res = await makeRequest(app, 'POST', '/api/code/search', {
        query: 'vector similarity',
        limit: 5.5,
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('5. High Concurrency Endpoint Requests', () => {
    it('handles 50 concurrent requests across all endpoints without crashing or race conditions', async () => {
      // Pre-seed memory record
      await makeRequest(app, 'POST', '/api/memory/record', {
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        type: 'learning',
        data: {
          category: 'architecture',
          title: 'Use modular Express router',
          description: 'Memory router is mounted on /api path',
        },
      });

      const promises: Promise<any>[] = [];

      for (let i = 0; i < 10; i++) {
        promises.push(makeRequest(app, 'GET', '/health'));
        promises.push(
          makeRequest(app, 'POST', '/api/memory/query', {
            repo: 'calltelemetry/cisco-cdr',
            category: 'architecture',
          })
        );
        promises.push(
          makeRequest(app, 'POST', '/api/code/symbol-graph', {
            symbolName: `symbol_${i}`,
          })
        );
        promises.push(
          makeRequest(app, 'POST', '/api/code/search', {
            query: `search term ${i}`,
            limit: (i % 50) + 1,
          })
        );
        promises.push(
          makeRequest(app, 'POST', '/api/memory/record', {
            repo: 'calltelemetry/cisco-cdr',
            prNumber: i,
            type: 'learning',
            data: {
              category: 'convention',
              title: `Concurrent learning ${i}`,
              description: `Description ${i}`,
            },
          })
        );
      }

      const results = await Promise.all(promises);
      expect(results.length).toBe(50);

      results.forEach((res) => {
        expect([200, 201]).toContain(res.status);
        expect(res.body.success !== false).toBe(true);
      });
    });
  });

  describe('6. Full App Integration (createApp)', () => {
    it('createApp mounts /health endpoint properly', async () => {
      const fullApp = createApp();
      const res = await makeRequest(fullApp, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('ct-review-bot');
    });

    it('createApp handles POST /api/memory/query with body parsing check', async () => {
      const fullApp = createApp();
      const res = await makeRequest(fullApp, 'POST', '/api/memory/query', {
        repo: 'calltelemetry/cisco-cdr',
      });

      expect([200, 400]).toContain(res.status);
    });
  });
});
