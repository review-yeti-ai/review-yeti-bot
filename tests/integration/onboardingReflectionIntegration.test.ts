import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 32: Onboarding & Reflection Integration', () => {
  let app: any;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();
  });

  it('executes onboarding wizard API and registers session memory rules', async () => {
    // 1. Trigger Onboarding Wizard API
    const wizardRes = await request(app)
      .post('/api/onboarding/wizard')
      .send({ repo: 'calltelemetry/cisco-cdr', autoCommit: false });

    expect(wizardRes.status).toBe(200);
    expect(wizardRes.body.success).toBe(true);
    expect(wizardRes.body.generatedConfig || wizardRes.body.yamlText).toContain('version: 3');

    // 2. Query Health endpoint to verify onboarding & reflection state
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('ok');
    expect(healthRes.body.memoryEngineReady).toBe(true);
    expect(healthRes.body.onboardingWizardReady).toBe(true);
  });
});
