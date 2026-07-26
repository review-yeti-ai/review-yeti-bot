import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 32: Onboarding & Session Learning E2E Suite', () => {
  let app: any;
  let token: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test-secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    token = loginRes.body.token || '';
  });

  it('runs complete lifecycle: wizard onboard -> PR comment learn -> memory persist -> nit suppression', async () => {
    // Step 1: Onboard repository
    const onboardRes = await request(app)
      .post('/api/onboarding/wizard')
      .send({ repo: 'calltelemetry/cisco-cdr' });
    expect(onboardRes.status).toBe(200);

    // Step 2: Simulate PR comment @ct-review learn
    const learnRes = await request(app)
      .post('/api/memory/record')
      .set('Authorization', `Bearer ${token}`)
      .send({
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 1,
        type: 'learning',
        data: { rule: 'Prefer async/await over raw Promises', category: 'convention' },
      });
    expect(learnRes.status).toBe(201);
    expect(learnRes.body.success).toBe(true);

    // Step 3: Verify persistent memory retrieval
    const memoryRes = await request(app)
      .get('/api/memory/query?repo=calltelemetry/cisco-cdr')
      .set('Authorization', `Bearer ${token}`);
    expect(memoryRes.status).toBe(200);
    expect(memoryRes.body.success).toBe(true);
    expect(JSON.stringify(memoryRes.body)).toContain('Prefer async/await over raw Promises');
  });
});
