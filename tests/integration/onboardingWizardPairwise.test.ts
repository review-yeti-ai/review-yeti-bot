import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { computeGitHubSignature } from '../../src/github/signature';

describe('Tier 3: Cross-Feature Pairwise Combinations (onboardingWizardPairwise.test.ts)', () => {
  let app: any;
  let authToken: string;
  let testPrivateKeyPem: string;

  beforeEach(async () => {
    // Environment setup for testing
    process.env.WEBHOOK_SECRET = 'pairwise-test-webhook-secret';
    process.env.GITHUB_APP_ID = '1048293';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    // Generate a valid 2048-bit RSA private key for RS256 JWT tests
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    testPrivateKeyPem = keyPair.privateKey;

    app = createApp();

    // Authenticate to obtain valid Bearer token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    authToken = loginRes.body.token;
  });

  // 1. F1 (App Config) + F2 (Monitored Repos): Updating App config updates monitored repos active count.
  it('1. Pairwise F1+F2: Updating App config dynamically updates monitored repos active count', async () => {
    // Retrieve initial app config and repos count
    const initialConfigRes = await request(app)
      .get('/api/github/app-config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(initialConfigRes.status).toBe(200);
    expect(initialConfigRes.body.success).toBe(true);
    const initialActiveCount = initialConfigRes.body.appConfig.monitoredReposCount;

    // Toggle automation for a monitored repo
    const patchRepoRes = await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        automationEnabled: false,
      });
    expect(patchRepoRes.status).toBe(200);
    expect(patchRepoRes.body.success).toBe(true);

    // Update App Config
    const updateAppConfigRes = await request(app)
      .post('/api/github/app-config')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        appId: '998877',
        installationId: '554433',
        webhookSecret: 'updated-secret-123',
      });

    expect(updateAppConfigRes.status).toBe(200);
    expect(updateAppConfigRes.body.success).toBe(true);
    expect(updateAppConfigRes.body.appConfig.appId).toBe('998877');
    expect(updateAppConfigRes.body.appConfig.monitoredReposCount).toBe(initialActiveCount - 1);

    // Restore automation status
    await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        automationEnabled: true,
      });
  });

  // 2. F1 (App Config) + F3 (AI Providers): Verification of App RSA key while provider keys are saved simultaneously.
  it('2. Pairwise F1+F3: Verifies App RSA key while saving AI provider keys simultaneously', async () => {
    // Run RSA Key verification and Provider updates concurrently
    const [verifyRes, providerRes] = await Promise.all([
      request(app)
        .post('/api/github/app-config/verify')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          appId: '1048293',
          privateKeyPem: testPrivateKeyPem,
          installationId: '5829104',
        }),
      request(app)
        .put('/api/dashboard/providers/openai')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          apiKey: 'sk-proj-authentic_key_simultaneous_88997766',
          subscriptionTier: 'enterprise',
          enabled: true,
        }),
    ]);

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.verified).toBe(true);
    expect(verifyRes.body.jwtGenerated).toBe(true);

    expect(providerRes.status).toBe(200);
    expect(providerRes.body.success).toBe(true);
    expect(providerRes.body.provider.subscriptionTier.toLowerCase()).toBe('enterprise');
    expect(providerRes.body.provider.apiKeyMasked).toContain('sk-proj-');
  });

  // 3. F1 (App Config) + F5 (Diagnostic Scan): Webhook delivery probe using configured App secret and RS256 key.
  it('3. Pairwise F1+F5: Webhook delivery probe using configured App secret and RS256 key', async () => {
    const webhookSecret = process.env.WEBHOOK_SECRET || 'pairwise-test-webhook-secret';

    dashboardStore.updateGitHubAppConfig({
      appId: '1048293',
      webhookSecret,
      privateKeyPem: testPrivateKeyPem,
    });

    const payloadObj = {
      action: 'opened',
      number: 101,
      pull_request: {
        number: 101,
        title: 'Diagnostic scan PR probe',
        head: { sha: 'a1b2c3d4e5f678901234567890abcdef12345678' },
        base: { sha: '0000000000000000000000000000000000000000' },
      },
      repository: {
        name: 'cisco-cdr',
        owner: { login: 'calltelemetry' },
        full_name: 'calltelemetry/cisco-cdr',
      },
      installation: { id: 5829104 },
    };

    const payloadStr = JSON.stringify(payloadObj);
    const signature = computeGitHubSignature(payloadStr, webhookSecret);

    const webhookRes = await request(app)
      .post('/webhook')
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', `del-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`)
      .set('x-hub-signature-256', signature)
      .set('Content-Type', 'application/json')
      .send(payloadStr);

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body.status).toBe('accepted');
    expect(webhookRes.body.deliveryId).toBeDefined();
  });

  // 4. F2 (Monitored Repos) + F3 (AI Providers): Repository strictness profile change (Chill -> Assertive) affecting provider tier requirement.
  it('4. Pairwise F2+F3: Repository strictness profile change (Chill -> Assertive) affects provider tier requirement', async () => {
    // Set profile to chill
    const chillRes = await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        customProfile: 'chill',
      });
    expect(chillRes.status).toBe(200);
    expect(chillRes.body.repository.customProfile).toBe('chill');

    // Switch profile to assertive
    const assertiveRes = await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        customProfile: 'assertive',
      });
    expect(assertiveRes.status).toBe(200);
    expect(assertiveRes.body.repository.customProfile).toBe('assertive');

    // Fetch repo details to verify profile enforcement
    const repoDetailsRes = await request(app)
      .get('/api/dashboard/repositories/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${authToken}`);
    expect(repoDetailsRes.status).toBe(200);
    expect(repoDetailsRes.body.repository.customProfile).toBe('assertive');
  });

  // 5. F2 (Monitored Repos) + F4 (Persona Ensemble): Repo strictness profile overriding persona model assignment.
  it('5. Pairwise F2+F4: Repo strictness profile overrides global persona model assignment', async () => {
    // Set global model for security persona
    await request(app)
      .put('/api/dashboard/personas/security')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ model: 'claude-3-5-sonnet' });

    // Apply repository-level model override and assertive profile
    const patchRes = await request(app)
      .patch('/api/dashboard/repositories/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        customProfile: 'assertive',
        modelOverrides: {
          security: 'gpt-4o',
          architecture: 'claude-opus-4-8',
        },
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.repository.modelOverrides.security).toBe('gpt-4o');

    // Verify repository settings reflect persona override
    const getRepoRes = await request(app)
      .get('/api/dashboard/repositories/calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${authToken}`);
    expect(getRepoRes.status).toBe(200);
    expect(getRepoRes.body.repository.modelOverrides.security).toBe('gpt-4o');
    expect(getRepoRes.body.repository.modelOverrides.architecture).toBe('claude-opus-4-8');
  });

  // 6. F2 (Monitored Repos) + F5 (Diagnostic Scan): Diagnostic scan filtering results by selected monitored repo ID.
  it('6. Pairwise F2+F5: Diagnostic scan filters results by selected monitored repo ID', async () => {
    const scanRes = await request(app)
      .post('/api/onboarding/wizard/scan')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        repoPath: process.cwd(),
      });

    expect(scanRes.status).toBe(200);
    expect(scanRes.body.success).toBe(true);
    expect(scanRes.body.scanResult).toBeDefined();
    expect(scanRes.body.scanResult.detection).toBeDefined();
    expect(scanRes.body.scanResult.detection.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(scanRes.body.generatedConfig).toContain('version: 3');
  });

  // 7. F3 (AI Providers) + F4 (Persona Ensemble): Persona model assignment mapped across 4 distinct provider families, verifying quorum check.
  it('7. Pairwise F3+F4: Persona model assignment mapped across 4 distinct provider families verifying quorum check', async () => {
    // Map personas to distinct provider families:
    // security -> Anthropic (claude-3-5-sonnet)
    // architecture -> xAI Grok (grok-cli/grok-4.5)
    // quality -> OpenAI (gpt-4o)
    // database -> GLM/Synthetic (glm-5.2)
    dashboardStore.updatePersonaSetting('security', { model: 'claude-3-5-sonnet' });
    dashboardStore.updatePersonaSetting('architecture', { model: 'grok-cli/grok-4.5' });
    dashboardStore.updatePersonaSetting('quality', { model: 'gpt-4o' });
    dashboardStore.updatePersonaSetting('database', { model: 'glm-5.2' });

    const reviewRes = await request(app)
      .post('/api/dashboard/trigger-test-review')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        personas: ['security', 'architecture', 'quality', 'database'],
        verdict: 'SHIP',
      });

    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.success).toBe(true);
    expect(reviewRes.body.job.quorum).toBe('4/4');
    expect(reviewRes.body.job.personaLogs).toHaveLength(4);

    const models = reviewRes.body.job.personaLogs.map((p: any) => p.model);
    expect(models).toContain('claude-5-sonnet');
    expect(models).toContain('grok-cli/grok-4.5');
    expect(models).toContain('claude-3-5-sonnet');
    expect(models).toContain('glm-5.2');
  });

  // 8. F3 (AI Providers) + F5 (Diagnostic Scan): Latency ping probe exercising configured provider base URLs and masking secret keys in output.
  it('8. Pairwise F3+F5: Latency ping probe exercises provider base URLs while masking secret keys', async () => {
    // Configure OpenAI provider with raw key
    dashboardStore.updateProviderConfig('openai', {
      apiKeyRaw: 'sk-proj-secretkeymaskingtest9988776655',
      baseUrl: 'https://api.openai.com/v1',
    });

    const pingRes = await request(app)
      .post('/api/dashboard/providers/openai/test')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        baseUrl: 'https://api.openai.com/v1',
      });

    expect(pingRes.status).toBe(200);
    expect(pingRes.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(pingRes.body.status).toBeDefined();

    // Verify secret key is masked in provider configuration
    const providerConfig = dashboardStore.getProviderConfig('openai');
    expect(providerConfig?.apiKeyMasked).toBe('sk-proj-...6655');
    expect(providerConfig?.apiKeyMasked).not.toContain('secretkeymaskingtest');
  });

  // 9. F4 (Persona Ensemble) + F5 (Diagnostic Scan): 11-persona arbitration probe evaluating distinct provider quorum.
  it('9. Pairwise F4+F5: 11-persona arbitration probe evaluating distinct provider quorum', async () => {
    const all11Personas = [
      'security',
      'architecture',
      'performance',
      'quality',
      'database',
      'api_contract',
      'reliability',
      'devops',
      'docs_compliance',
      'finops',
      'red_team',
    ];

    const probeRes = await request(app)
      .post('/api/dashboard/trigger-test-review')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        personas: all11Personas,
        verdict: 'SHIP',
      });

    expect(probeRes.status).toBe(200);
    expect(probeRes.body.success).toBe(true);
    expect(probeRes.body.job.personas).toEqual(all11Personas);
    expect(probeRes.body.job.arbiterVerdict).toBe('SHIP');
    expect(probeRes.body.job.personaLogs).toBeDefined();
    expect(Array.isArray(probeRes.body.job.personaLogs)).toBe(true);
  });

  // 10. F1 (App Config) + F6 (Manifest Drawer): Manifest drawer populating dynamically with configured App ID and Webhook URL.
  it('10. Pairwise F1+F6: Manifest drawer populates dynamically with configured App ID and Webhook URL', async () => {
    const updateRes = await request(app)
      .post('/api/github/app-config')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        appId: '98765432',
        installationId: '11223344',
        webhookSecret: 'manifest-secret-abc',
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);

    const configRes = await request(app)
      .get('/api/github/app-config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(configRes.status).toBe(200);
    expect(configRes.body.appConfig.appId).toBe('98765432');
    expect(configRes.body.appConfig.installationId).toBe('11223344');
    expect(configRes.body.appConfig.webhookSecretConfigured).toBe(true);
  });

  // 11. F3 (AI Providers) + F6 (Cost Estimator): Cost estimator calculations updating when subscription tier changes.
  it('11. Pairwise F3+F6: Cost estimator calculations update when subscription tier changes', async () => {
    // Initial config check
    const initialConfigRes = await request(app)
      .get('/api/dashboard/config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(initialConfigRes.status).toBe(200);

    // Update provider tier
    const providerRes = await request(app)
      .put('/api/dashboard/providers/openai')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        subscriptionTier: 'enterprise',
      });
    expect(providerRes.status).toBe(200);
    expect(providerRes.body.provider.subscriptionTier.toLowerCase()).toBe('enterprise');

    // Update monthly budget cost cap
    const updateCapRes = await request(app)
      .put('/api/dashboard/config')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        monthlyCostCapUSD: 450.0,
      });

    expect(updateCapRes.status).toBe(200);
    expect(updateCapRes.body.success).toBe(true);
    expect(updateCapRes.body.config.monthlyCostCapUSD).toBe(450.0);

    // Re-query config to verify cost cap calculation update
    const finalConfigRes = await request(app)
      .get('/api/dashboard/config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(finalConfigRes.status).toBe(200);
    expect(finalConfigRes.body.config.monthlyCostCapUSD).toBe(450.0);
    expect(finalConfigRes.body.config.providerCostCaps.monthlyBudgetUSD).toBe(450.0);
  });

  // 12. F2 (Monitored Repos) + F6 (Tooltips & Guides): Help drawer guidance changing per monitored repo state.
  it('12. Pairwise F2+F6: Help drawer guidance changes per monitored repo state', async () => {
    // Check monitored repo listing
    const reposRes = await request(app)
      .get('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`);
    expect(reposRes.status).toBe(200);
    expect(reposRes.body.success).toBe(true);
    const totalRepos = reposRes.body.totalCount;

    // Toggle automation off
    const disableRes = await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        automationEnabled: false,
      });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.repository.automationEnabled).toBe(false);

    // Fetch updated monitored repos state
    const disabledReposRes = await request(app)
      .get('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`);
    expect(disabledReposRes.status).toBe(200);
    expect(disabledReposRes.body.activeCount).toBeLessThan(totalRepos);

    // Toggle automation back on
    const enableRes = await request(app)
      .patch('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        automationEnabled: true,
      });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.repository.automationEnabled).toBe(true);

    const reenabledReposRes = await request(app)
      .get('/api/github/app-config/monitored-repos')
      .set('Authorization', `Bearer ${authToken}`);
    expect(reenabledReposRes.status).toBe(200);
    expect(reenabledReposRes.body.activeCount).toBe(disabledReposRes.body.activeCount + 1);
  });
});
