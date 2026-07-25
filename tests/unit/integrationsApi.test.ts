import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createIntegrationsRouter } from '../../src/dashboard/integrationsApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import fs from 'fs';

describe('Integrations REST API Unit Tests', () => {
  let app: Express;
  const testStorePath = '/tmp/ct-review-bot/integrations-api-test.json';

  beforeEach(() => {
    process.env.CT_DASHBOARD_STORE = testStorePath;
    if (fs.existsSync(testStorePath)) {
      fs.unlinkSync(testStorePath);
    }
    app = express();
    app.use(express.json());
    const router = createIntegrationsRouter();
    app.use('/api/dashboard', router);
    app.use('/api/dashboard/integrations', router);
    app.use('/api/dashboard/mcp', router);
  });

  afterEach(() => {
    if (fs.existsSync(testStorePath)) {
      try {
        fs.unlinkSync(testStorePath);
      } catch {
        // ignore
      }
    }
  });

  it('GET /api/dashboard/integrations returns linked integrations with masked API keys', async () => {
    const res = await request(app).get('/api/dashboard/integrations');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.integrations)).toBe(true);
    expect(res.body.integrations.length).toBeGreaterThan(0);

    const linearInt = res.body.integrations.find((i: any) => i.id === 'linear');
    expect(linearInt).toBeDefined();
    expect(linearInt.apiKeyMasked).toMatch(/\.\.\./);
    expect(linearInt.apiKey).toBeUndefined();
    expect(linearInt.oauthClientSecret).toBeUndefined();

    for (const integration of res.body.integrations) {
      expect(integration.apiKey).toBeUndefined();
      expect(integration.oauthClientSecret).toBeUndefined();
    }
  });

  it('POST /api/dashboard/integrations updates platform credentials and returns masked key', async () => {
    const res = await request(app)
      .post('/api/dashboard/integrations')
      .send({
        platform: 'linear',
        apiKey: 'lin_api_99887766554433221100',
        oauthClientSecret: 'sec_1234567890secret',
        settings: { teamKey: 'DEV' },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.integration).toBeDefined();
    expect(res.body.integration.id).toBe('linear');
    expect(res.body.integration.apiKeyMasked).toBe('lin_api_...1100');
    expect(res.body.integration.oauthClientSecretMasked).toBe('sec_1234...cret');
    expect(res.body.integration.apiKey).toBeUndefined();
    expect(res.body.integration.oauthClientSecret).toBeUndefined();
    expect(res.body.integration.status).toBe('connected');

    if (res.body.integrations) {
      const updatedLinear = res.body.integrations.find((i: any) => i.id === 'linear');
      expect(updatedLinear).toBeDefined();
      expect(updatedLinear.apiKey).toBeUndefined();
      expect(updatedLinear.oauthClientSecret).toBeUndefined();
      expect(updatedLinear.apiKeyMasked).toBe('lin_api_...1100');
      expect(updatedLinear.oauthClientSecretMasked).toBe('sec_1234...cret');
    }
  });

  it('POST /api/dashboard/integrations returns 400 for unsupported platform', async () => {
    const res = await request(app)
      .post('/api/dashboard/integrations')
      .send({
        platform: 'unknown_platform',
        apiKey: 'secret_123',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid or missing platform');
  });

  it('GET /api/dashboard/mcp/servers returns configured MCP fleet servers', async () => {
    const res = await request(app).get('/api/dashboard/mcp/servers');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.servers)).toBe(true);
    const context7Server = res.body.servers.find((s: any) => s.id === 'builtin-context7');
    expect(context7Server).toBeDefined();
    expect(context7Server.transport).toBe('adapter');
  });

  it('POST /api/dashboard/mcp/servers creates custom MCP server', async () => {
    const res = await request(app)
      .post('/api/dashboard/mcp/servers')
      .send({
        name: 'Sentry Error Tracker',
        transport: 'http',
        url: 'http://localhost:8080/mcp',
        enabled: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.server.id).toBeDefined();
    expect(res.body.server.name).toBe('Sentry Error Tracker');
    expect(res.body.server.transport).toBe('http');
  });

  it('POST /api/dashboard/mcp/servers returns 400 when transport requirement missing', async () => {
    const res = await request(app)
      .post('/api/dashboard/mcp/servers')
      .send({
        name: 'Broken HTTP Server',
        transport: 'http',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('HTTP transport requires endpoint URL');
  });

  it('PATCH /api/dashboard/mcp/servers/:id updates server enabled toggle', async () => {
    // 1. Add server
    const addRes = await request(app)
      .post('/api/dashboard/mcp/servers')
      .send({
        name: 'Toggleable Server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server'],
      });
    const serverId = addRes.body.server.id;

    // 2. Disable server via PATCH
    const patchRes = await request(app)
      .patch(`/api/dashboard/mcp/servers/${serverId}`)
      .send({ enabled: false });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.server.enabled).toBe(false);
  });

  it('DELETE /api/dashboard/mcp/servers/:id deletes custom MCP server', async () => {
    // 1. Add server
    const addRes = await request(app)
      .post('/api/dashboard/mcp/servers')
      .send({
        name: 'Temporary Server',
        transport: 'http',
        url: 'http://localhost:9090/mcp',
      });
    const serverId = addRes.body.server.id;

    // 2. Delete server
    const delRes = await request(app).delete(`/api/dashboard/mcp/servers/${serverId}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // 3. Verify deletion
    const getRes = await request(app).get('/api/dashboard/mcp/servers');
    const found = getRes.body.servers.find((s: any) => s.id === serverId);
    expect(found).toBeUndefined();
  });

  it('POST /api/dashboard/mcp/test performs connectivity check for builtin adapter', async () => {
    const res = await request(app)
      .post('/api/dashboard/mcp/test')
      .send({ serverId: 'builtin-context7' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.toolsDiscovered).toContain('fetch_docs');
    expect(res.body.status).toBe('online');
  });
});
