import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Dashboard Integrations & Store E2E Integration Suite', () => {
  let app: any;
  let apiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    app = createApp();
    const createdKey = dashboardStore.createApiKey('integration-e2e-key');
    apiKey = createdKey.rawKey;
  });

  it('1. handles end-to-end integration lifecycle: read -> configure credentials -> test status -> deregister', async () => {
    // Step 1: Read integrations list
    const getRes = await request(app)
      .get('/api/dashboard/integrations')
      .set('x-api-key', apiKey);
    expect(getRes.status).toBe(200);

    // Step 2: Configure credentials
    const configRes = await request(app)
      .post('/api/dashboard/integrations')
      .set('x-api-key', apiKey)
      .send({
        platform: 'linear',
        apiKey: 'lin_api_e2e_secret_token_123456',
        settings: { teamKey: 'PROD' },
      });
    expect(configRes.status).toBe(200);
    expect(configRes.body.integration.status).toBe('connected');

    // Step 3: Add and test custom MCP server
    const addMcpRes = await request(app)
      .post('/api/dashboard/mcp/servers')
      .set('x-api-key', apiKey)
      .send({
        name: 'E2E Test MCP Server',
        transport: 'http',
        url: 'https://mcp-e2e.internal.local',
      });
    expect(addMcpRes.status).toBe(201);
    const mcpId = addMcpRes.body.server.id;

    // Step 4: Deregister MCP server
    const deleteRes = await request(app)
      .delete(`/api/dashboard/mcp/${mcpId}`)
      .set('x-api-key', apiKey);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
  });

  it('2. verifies persistent state round-trip across DashboardStore and integrations API', async () => {
    const patchRes = await request(app)
      .post('/api/dashboard/integrations')
      .set('x-api-key', apiKey)
      .send({
        platform: 'productlane',
        apiKey: 'pl_live_secret_token_999888777',
      });
    expect(patchRes.status).toBe(200);

    const storeItem = dashboardStore.getIntegration('productlane');
    expect(storeItem).toBeDefined();
    expect(storeItem?.status).toBe('connected');
    expect(storeItem?.apiKeyMasked).toContain('pl_live_');
  });

  it('3. validates authenticated API key access flow end-to-end across multiple routes', async () => {
    const routes = [
      '/api/dashboard/integrations',
      '/api/dashboard/mcp/fleet',
      '/api/dashboard/repositories',
    ];

    for (const route of routes) {
      const res = await request(app).get(route).set('x-api-key', apiKey);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  it('4. verifies error handling for unauthorized requests and malformed parameters', async () => {
    const unauthRes = await request(app).get('/api/dashboard/integrations');
    expect(unauthRes.status).toBe(401);

    const badPayloadRes = await request(app)
      .post('/api/dashboard/integrations')
      .set('x-api-key', apiKey)
      .send({ platform: '' });
    expect(badPayloadRes.status).toBe(400);

    const notFoundRes = await request(app)
      .delete('/api/dashboard/mcp/unknown-server-id-1234')
      .set('x-api-key', apiKey);
    expect(notFoundRes.status).toBe(404);
  });
});
