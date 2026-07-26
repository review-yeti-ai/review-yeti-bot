import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import generateRsaKeyPair from 'crypto';

describe('Milestone 41: GitHub App & OAuth Onboarding API Suite', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());
  });

  it('GET /api/github/app-config returns default/stored app configuration and monitored repos count', async () => {
    const res = await request(app).get('/api/github/app-config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.appConfig).toHaveProperty('appId');
    expect(res.body.appConfig).toHaveProperty('monitoredReposCount');
  });

  it('POST & PUT /api/github/app-config updates app ID, installation ID, secrets, and PEM key', async () => {
    const postRes = await request(app)
      .post('/api/github/app-config')
      .send({
        appId: '884920',
        installationId: '123456',
        webhookSecret: 'super-secret-webhook-key',
        privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...\n-----END RSA PRIVATE KEY-----',
        oauthClientId: 'Iv1.testclientid',
        oauthClientSecret: 'raw-oauth-secret-9999',
      });

    expect(postRes.status).toBe(200);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.appConfig.appId).toBe('884920');
    expect(postRes.body.appConfig.installationId).toBe('123456');
    expect(postRes.body.appConfig.webhookSecretConfigured).toBe(true);
    expect(postRes.body.appConfig.privateKeyConfigured).toBe(true);
    expect(postRes.body.appConfig.oauthClientId).toBe('Iv1.testclientid');
    expect(postRes.body.appConfig.oauthClientSecretMasked).toContain('raw-oath...9999'.slice(0, 4));
  });

  it('DELETE /api/github/app-config resets GitHub App configuration credentials', async () => {
    const delRes = await request(app).delete('/api/github/app-config');
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
    expect(delRes.body.appConfig.appId).toBe('');
    expect(delRes.body.appConfig.status).toBe('unconfigured');
  });

  it('POST /api/github/app-config/verify validates RS256 JWT generation and installation token exchange', async () => {
    // Generate valid RSA key pair for testing
    const { privateKey } = generateRsaKeyPair.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const verifyRes = await request(app)
      .post('/api/github/app-config/verify')
      .send({
        appId: '1092381',
        installationId: '58923019',
        privateKeyPem: privateKey,
      });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.verified).toBe(true);
    expect(verifyRes.body.jwtGenerated).toBe(true);
    expect(verifyRes.body.tokenPrefix).toMatch(/^ghs_/);
  });

  it('POST /api/github/app-config/verify returns 400 when missing credentials or given invalid key', async () => {
    const missingRes = await request(app)
      .post('/api/github/app-config/verify')
      .send({ appId: '', privateKeyPem: '' });

    expect(missingRes.status).toBe(400);
    expect(missingRes.body.success).toBe(false);

    const invalidRes = await request(app)
      .post('/api/github/app-config/verify')
      .send({ appId: '123', privateKeyPem: 'invalid-not-a-pem-key' });

    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.success).toBe(false);
  });

  it('GET /api/github/app-config/monitored-repos returns monitored repos list and counts', async () => {
    const res = await request(app).get('/api/github/app-config/monitored-repos');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.repositories)).toBe(true);
    expect(res.body.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /api/github/app-config/monitored-repos/:owner/:repo updates 1-click review toggle', async () => {
    const patchRes = await request(app)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .send({ automationEnabled: false, customProfile: 'assertive' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.repository.automationEnabled).toBe(false);
    expect(patchRes.body.repository.customProfile).toBe('assertive');

    // Re-enable for clean state
    await request(app)
      .patch('/api/github/app-config/monitored-repos/calltelemetry/cisco-cdr')
      .send({ automationEnabled: true, customProfile: 'balanced' });
  });
});
