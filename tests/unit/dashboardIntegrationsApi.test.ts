import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Dashboard Integrations & MCP Fleet API Suite', () => {
  let app: any;
  let validApiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    app = createApp();
    const createdKey = dashboardStore.createApiKey('test-integration-key');
    validApiKey = createdKey.rawKey;
  });

  it('1. GET /api/dashboard/integrations returns active integrations list', async () => {
    const res = await request(app)
      .get('/api/dashboard/integrations')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.integrations)).toBe(true);
    expect(res.body.integrations.length).toBeGreaterThan(0);
    expect(res.body.integrations.some((i: any) => i.id === 'linear')).toBe(true);
  });

  it('2. POST /api/dashboard/integrations updates integration credentials', async () => {
    const res = await request(app)
      .post('/api/dashboard/integrations')
      .set('x-api-key', validApiKey)
      .send({
        platform: 'linear',
        apiKey: 'lin_api_secret_token_123456789',
        settings: { teamKey: 'DEV' },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.integration).toBeDefined();
    expect(res.body.integration.id).toBe('linear');
    expect(res.body.integration.status).toBe('connected');
    expect(res.body.integration.apiKeyMasked).toContain('lin_api_');
  });

  it('3. GET /api/dashboard/mcp/fleet returns connected MCP server status', async () => {
    const res = await request(app)
      .get('/api/dashboard/mcp/fleet')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.servers)).toBe(true);
  });

  it('4. POST /api/dashboard/mcp/test triggers ping & tool verification', async () => {
    const res = await request(app)
      .post('/api/dashboard/mcp/test')
      .set('x-api-key', validApiKey)
      .send({
        id: 'builtin-context7',
        name: 'Context7 Documentation MCP',
        transport: 'adapter',
      });

    expect([200, 400, 502]).toContain(res.status);
    expect(res.body.status).toBeDefined();
    expect(Array.isArray(res.body.toolsDiscovered)).toBe(true);
  });

  it('5. DELETE /api/dashboard/mcp/:id deregisters MCP server', async () => {
    const addedServer = dashboardStore.addMcpServer({
      id: 'mcp-temp-delete-target',
      name: 'Temp Test MCP',
      transport: 'http',
      url: 'https://mcp.test.internal',
    });

    const res = await request(app)
      .delete(`/api/dashboard/mcp/${addedServer.id}`)
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('deleted successfully');
  });

  it('6. enforces API key authentication on integrations endpoints', async () => {
    const res = await request(app).get('/api/dashboard/integrations');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('7. returns 400 Bad Request for malformed integration payloads', async () => {
    const res = await request(app)
      .post('/api/dashboard/integrations')
      .set('x-api-key', validApiKey)
      .send({
        platform: 'invalid-non-existent-platform-xyz',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid or missing platform');
  });

  it('8. returns 404 Not Found for operations on non-existent MCP ID', async () => {
    const res = await request(app)
      .delete('/api/dashboard/mcp/non-existent-mcp-server-id-999')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('not found');
  });
});
