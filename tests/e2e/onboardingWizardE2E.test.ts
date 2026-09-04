import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from '../../src/app';
import { computeGitHubSignature } from '../../src/github/signature';
import { providerPool } from '../../src/gateway/providerPool';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Tier 4: Real-World Application Scenarios E2E Suite (Onboarding Wizard)', () => {
  let app: any;
  let server: any;
  let token: string;
  let realPrivateKey: string;

  beforeEach(async () => {
    // Generate valid RSA 2048-bit key for tests
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    realPrivateKey = keyPair.privateKey;

    process.env.ADMIN_PASSWORD = 'admin123';
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = realPrivateKey;
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    providerPool.clear();
    dashboardStore.updateGitHubAppConfig({
      appId: '12345',
      webhookSecret: 'test_webhook_secret',
      privateKeyPem: realPrivateKey,
      installationId: '67890',
    });

    app = createApp();
    server = app.listen(0);

    const loginRes = await request(server)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    token = loginRes.body.token || '';
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it(
    'Scenario 1: Complete Onboarding Workflow from Step 1 (App Connection) -> Step 2 (Repo Pick) -> Step 3 (Providers & Keys) -> Step 4 (Persona Ensemble) -> Step 5 (Diagnostic Scan SHIP verdict)',
    async () => {
      // Step 1: App Connection
      const appConfigGet = await request(server)
        .get('/api/github/app-config')
        .set('Authorization', `Bearer ${token}`);
      expect(appConfigGet.status).toBe(200);
      expect(appConfigGet.body.success).toBe(true);
      expect(appConfigGet.body.appConfig).toBeDefined();

      const appVerify = await request(server)
        .post('/api/github/app-config/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({
          appId: '12345',
          installationId: '67890',
          privateKeyPem: realPrivateKey,
        });
      expect(appVerify.status).toBe(200);
      expect(appVerify.body.success).toBe(true);
      expect(appVerify.body.verified).toBe(true);
      expect(appVerify.body.jwtGenerated).toBe(true);

      // Step 2: Repo Pick
      const scanRes = await request(server)
        .post('/api/onboarding/wizard/scan')
        .send({ repoPath: process.cwd() });
      expect(scanRes.status).toBe(200);
      expect(scanRes.body.success).toBe(true);
      expect(scanRes.body.scanResult).toBeDefined();

      const repoPick = await request(server)
        .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
        .set('Authorization', `Bearer ${token}`)
        .send({ automationEnabled: true, customProfile: 'assertive' });
      expect(repoPick.status).toBe(200);
      expect(repoPick.body.success).toBe(true);
      expect(repoPick.body.repository.automationEnabled).toBe(true);

      // Step 3: Providers & Keys
      const providersGet = await request(server)
        .get('/api/dashboard/providers')
        .set('Authorization', `Bearer ${token}`);
      expect(providersGet.status).toBe(200);
      expect(providersGet.body.success).toBe(true);
      expect(providersGet.body.providers).toBeDefined();

      const providerUpdate = await request(server)
        .put('/api/dashboard/providers/openai')
        .set('Authorization', `Bearer ${token}`)
        .send({ enabled: true, subscriptionTier: 'enterprise' });
      expect(providerUpdate.status).toBe(200);
      expect(providerUpdate.body.success).toBe(true);

      // Step 4: Persona Ensemble
      const genConfig = await request(server)
        .post('/api/onboarding/wizard/generate')
        .send({
          scanResult: scanRes.body.scanResult,
          profile: 'assertive',
          selectedPersonaIds: ['security', 'architecture', 'quality', 'database'],
        });
      expect(genConfig.status).toBe(200);
      expect(genConfig.body.success).toBe(true);
      expect(genConfig.body.yamlText).toBeDefined();

      const personaUpdate = await request(server)
        .put('/api/dashboard/personas/security')
        .set('Authorization', `Bearer ${token}`)
        .send({ confidenceThreshold: 90, effort: 'max', enabled: true });
      expect(personaUpdate.status).toBe(200);
      expect(personaUpdate.body.success).toBe(true);
      expect(personaUpdate.body.persona.confidenceThreshold).toBe(90);

      // Step 5: Diagnostic Scan SHIP verdict
      const testReview = await request(server)
        .post('/api/dashboard/trigger-test-review')
        .send({ repo: 'calltelemetry/cisco-cdr', verdict: 'SHIP' });
      expect(testReview.status).toBe(200);
      expect(testReview.body.success).toBe(true);
      expect(testReview.body.job).toBeDefined();
      expect(testReview.body.job.status).toBe('completed');
      expect(testReview.body.job.verdict).toBe('SHIP');
    },
    30000
  );

  it('Scenario 2: Add Custom OpenAI-compatible Provider with Enterprise Subscription Tier and custom model llama3-70b-finetuned, assign to Security Persona, run test ping', async () => {
    // 1. Register custom provider in provider pool via router endpoint
    const regRes = await request(server)
      .post('/api/router/providers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'custom-openai-ent',
        type: 'openai',
        apiKey: 'sk-ent-llama3-key-99999',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['llama3-70b-finetuned'],
      });
    expect(regRes.status).toBe(201);
    expect(regRes.body.success).toBe(true);
    expect(regRes.body.provider.id).toBe('custom-openai-ent');
    expect(regRes.body.provider.models).toContain('llama3-70b-finetuned');

    // Update dashboard store config to sync models into getDynamicActiveModels()
    const dashboardProvider = await request(server)
      .put('/api/dashboard/providers/custom-openai-ent')
      .set('Authorization', `Bearer ${token}`)
      .send({
        id: 'custom-openai-ent',
        displayName: 'Custom Enterprise OpenAI',
        enabled: true,
        subscriptionTier: 'enterprise',
        activeModels: ['llama3-70b-finetuned'],
        customModels: ['llama3-70b-finetuned'],
      });
    expect(dashboardProvider.status).toBe(200);
    expect(dashboardProvider.body.success).toBe(true);

    // Verify in provider list
    const listRes = await request(server)
      .get('/api/router/providers')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const found = listRes.body.providers.find((p: any) => p.id === 'custom-openai-ent');
    expect(found).toBeDefined();

    // 2. Assign custom model to Security Persona
    const personaUpdate = await request(server)
      .put('/api/dashboard/personas/security')
      .set('Authorization', `Bearer ${token}`)
      .send({
        model: 'llama3-70b-finetuned',
        providerId: 'custom-openai-ent',
      });
    expect(personaUpdate.status).toBe(200);
    expect(personaUpdate.body.success).toBe(true);
    expect(personaUpdate.body.persona.model).toBe('llama3-70b-finetuned');

    // 3. Run test ping using local mock server
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', models: ['llama3-70b-finetuned'] }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = (mockServer.address() as any).port;

    try {
      const testPing = await request(server)
        .post('/api/dashboard/providers/custom-openai-ent/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseUrl: `http://127.0.0.1:${mockPort}` });
      expect(testPing.status).toBe(200);
      expect(testPing.body.success).toBe(true);
      expect(testPing.body.status).toBe('connected');
      expect(testPing.body.latencyMs).toBeGreaterThanOrEqual(1);
    } finally {
      mockServer.close();
    }
  });

  it('Scenario 3: Monitored Repo Strictness Profile Change from Chill to Assertive, toggle automation off and back on, verify enforcement policy persistence', async () => {
    // 1. Set customProfile to 'chill'
    const chillRes = await request(server)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${token}`)
      .send({ customProfile: 'chill' });
    expect(chillRes.status).toBe(200);
    expect(chillRes.body.success).toBe(true);
    expect(chillRes.body.repository.customProfile).toBe('chill');

    // Change to 'assertive'
    const assertiveRes = await request(server)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${token}`)
      .send({ customProfile: 'assertive' });
    expect(assertiveRes.status).toBe(200);
    expect(assertiveRes.body.repository.customProfile).toBe('assertive');

    // 2. Toggle automation off
    const toggleOff = await request(server)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${token}`)
      .send({ automationEnabled: false });
    expect(toggleOff.status).toBe(200);
    expect(toggleOff.body.repository.automationEnabled).toBe(false);

    // Verify in monitored-repos listing
    const listRepos = await request(server)
      .get('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${token}`);
    expect(listRepos.status).toBe(200);
    const cdrRepo = listRepos.body.repositories.find(
      (r: any) => r.owner === 'calltelemetry' && r.repo === 'cisco-cdr'
    );
    expect(cdrRepo.automationEnabled).toBe(false);

    // Toggle automation back on
    const toggleOn = await request(server)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${token}`)
      .send({ automationEnabled: true });
    expect(toggleOn.status).toBe(200);
    expect(toggleOn.body.repository.automationEnabled).toBe(true);

    // 3. Update & Verify Enforcement Policy Persistence
    const policyUpdate = await request(server)
      .put('/api/github/enforcement-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({
        require_all_reviews: true,
        failure_action: 'fail_closed',
        require_ticket_link: true,
      });
    expect(policyUpdate.status).toBe(200);
    expect(policyUpdate.body.success).toBe(true);
    expect(policyUpdate.body.policy.require_ticket_link).toBe(true);
    expect(policyUpdate.body.policy.failure_action).toBe('fail_closed');

    const policyGet = await request(server)
      .get('/api/github/enforcement-policy')
      .set('Authorization', `Bearer ${token}`);
    expect(policyGet.status).toBe(200);
    expect(policyGet.body.policy.require_ticket_link).toBe(true);
    expect(policyGet.body.policy.failure_action).toBe('fail_closed');
  });

  it('Scenario 4: GitHub App Manifest JSON Copy, drawer opening, webhook secret re-verification, and RSA key update', async () => {
    // 1. Initial Drawer Config Inspection
    const initialConfig = await request(server)
      .get('/api/github/app-config')
      .set('Authorization', `Bearer ${token}`);
    expect(initialConfig.status).toBe(200);
    expect(initialConfig.body.success).toBe(true);

    // 2. Update credentials via Manifest flow POST
    const updateRes = await request(server)
      .post('/api/github/app-config')
      .set('Authorization', `Bearer ${token}`)
      .send({
        appId: 'manifest-app-777',
        webhookSecret: 'manifest-reverified-secret-99',
        privateKeyPem: realPrivateKey,
        installationId: 'inst-999111',
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.appConfig.appId).toBe('manifest-app-777');
    expect(updateRes.body.appConfig.webhookSecretRaw || updateRes.body.appConfig.webhookSecret).toBe(
      'manifest-reverified-secret-99'
    );

    // 3. Webhook secret re-verification & RSA key update test
    const verifyRes = await request(server)
      .post('/api/github/app-config/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({
        appId: 'manifest-app-777',
        privateKeyPem: realPrivateKey,
        installationId: 'inst-999111',
      });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.verified).toBe(true);
    expect(verifyRes.body.jwtGenerated).toBe(true);

    // 4. Persisted Credentials Validation
    const verifiedConfig = await request(server)
      .get('/api/github/app-config')
      .set('Authorization', `Bearer ${token}`);
    expect(verifiedConfig.status).toBe(200);
    expect(verifiedConfig.body.appConfig.appId).toBe('manifest-app-777');
    expect(verifiedConfig.body.appConfig.installationId).toBe('inst-999111');
  });

  it('Scenario 5: End-to-end Diagnostic Scan Execution with simulated webhook HMAC delivery, latency pings, and 11-persona binding arbitration quorum check', async () => {
    // 1. Simulated Webhook HMAC Delivery
    const secret = process.env.WEBHOOK_SECRET || 'test_webhook_secret';
    const deliveryId = `delivery-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const payloadObj = {
      action: 'opened',
      number: 101,
      pull_request: {
        number: 101,
        title: 'feat(core): add CDR ingestion queue',
        head: { sha: 'e2e-hmac-sha-555' },
      },
      repository: { name: 'cisco-cdr', owner: { login: 'calltelemetry' } },
      installation: { id: 12345 },
    };
    const signature = computeGitHubSignature(payloadObj, secret);

    const webhookRes = await request(server)
      .post('/webhook')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', deliveryId)
      .set('x-hub-signature-256', signature)
      .send(payloadObj);

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.status).toBe('accepted');
    expect(webhookRes.body.deliveryId).toBe(deliveryId);

    // 2. Latency Pings
    const pingDeliveryId = `delivery-ping-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const pingObj = { zen: 'Keep it simple' };
    const pingSig = computeGitHubSignature(pingObj, secret);
    const pingRes = await request(server)
      .post('/webhook')
      .set('x-github-event', 'ping')
      .set('x-github-delivery', pingDeliveryId)
      .set('x-hub-signature-256', pingSig)
      .send(pingObj);

    expect(pingRes.status).toBe(200);
    expect(pingRes.body.status).toBe('pong');

    const integrationTest = await request(server)
      .post('/api/dashboard/integrations/linear/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ apiKey: 'lin_api_test_key_123' });
    expect(integrationTest.status).toBe(200);
    expect(integrationTest.body.success).toBe(true);
    expect(integrationTest.body.latencyMs).toBeGreaterThanOrEqual(1);

    // 3. 11-Persona Binding Arbitration Quorum Check
    const personasRes = await request(server)
      .get('/api/dashboard/personas')
      .set('Authorization', `Bearer ${token}`);
    expect(personasRes.status).toBe(200);
    const personaIds = Object.keys(personasRes.body.personas);
    expect(personaIds.length).toBeGreaterThanOrEqual(11);
    expect(personaIds).toContain('security');
    expect(personaIds).toContain('architecture');
    expect(personaIds).toContain('red_team');

    const diagRun = await request(server)
      .post('/api/dashboard/trigger-test-review')
      .send({
        repo: 'calltelemetry/cisco-cdr',
        personas: personaIds,
        verdict: 'SHIP',
      });

    expect(diagRun.status).toBe(200);
    expect(diagRun.body.success).toBe(true);
    expect(diagRun.body.job.verdict).toBe('SHIP');
    expect(diagRun.body.job.status).toBe('completed');
    expect(diagRun.body.job.personaLogs.length).toBeGreaterThanOrEqual(4);
  });

  it('Scenario 6: Full multi-step error recovery: invalid RSA key -> fix key -> failing provider -> update provider key -> successful diagnostic scan', async () => {
    // Step 1: Invalid RSA key handling
    const invalidKeyRes = await request(server)
      .post('/api/github/app-config/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({
        appId: '12345',
        privateKeyPem: 'INVALID_RSA_KEY_PEM_CONTENT',
      });
    expect(invalidKeyRes.status).toBe(400);
    expect(invalidKeyRes.body.success).toBe(false);
    expect(invalidKeyRes.body.verified).toBe(false);
    expect(invalidKeyRes.body.error).toBeDefined();

    // Step 2: Fix key
    const fixedKeyRes = await request(server)
      .post('/api/github/app-config/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({
        appId: '12345',
        privateKeyPem: realPrivateKey,
        installationId: '12345',
      });
    expect(fixedKeyRes.status).toBe(200);
    expect(fixedKeyRes.body.success).toBe(true);
    expect(fixedKeyRes.body.verified).toBe(true);

    // Step 3: Failing provider check
    const failingPing = await request(server)
      .post('/api/dashboard/providers/openai/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ baseUrl: 'http://127.0.0.1:1/invalid' });
    expect(failingPing.body.success).toBe(false);
    expect(failingPing.body.status).toMatch(/disconnected|error/);

    // Step 4: Update provider key & endpoint
    const mockServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = (mockServer.address() as any).port;

    try {
      const providerUpdate = await request(server)
        .put('/api/dashboard/providers/openai')
        .set('Authorization', `Bearer ${token}`)
        .send({
          baseUrl: `http://127.0.0.1:${mockPort}`,
          apiKey: 'sk-fixed-provider-key-100',
          enabled: true,
        });
      expect(providerUpdate.status).toBe(200);

      const fixedPing = await request(server)
        .post('/api/dashboard/providers/openai/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseUrl: `http://127.0.0.1:${mockPort}` });
      expect(fixedPing.status).toBe(200);
      expect(fixedPing.body.success).toBe(true);
      expect(fixedPing.body.status).toBe('connected');
    } finally {
      mockServer.close();
    }

    // Step 5: Successful diagnostic scan after error recovery
    const finalScan = await request(server)
      .post('/api/dashboard/trigger-test-review')
      .send({
        repo: 'calltelemetry/cisco-cdr',
        verdict: 'SHIP',
      });
    expect(finalScan.status).toBe(200);
    expect(finalScan.body.success).toBe(true);
    expect(finalScan.body.job.status).toBe('completed');
    expect(finalScan.body.job.verdict).toBe('SHIP');
  });
});
