import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 41 & 42 Integration & Dashboard UI Route Suite', () => {
  let app: any;
  let authToken = '';

  beforeAll(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    app = createApp();
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' });
    authToken = loginRes.body.token || '';
  });

  it('GET /dashboard/github-app serves public/github-app.html', async () => {
    const res = await request(app).get('/dashboard/github-app');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('GitHub App');
    expect(res.text).toContain('OAuth Onboarding Portal');
    expect(res.text).toContain('Monitored Org Repositories Manager');
    expect(res.text).toContain('id="pem-dropzone"');
  });

  it('GET /js/github-app.js serves valid client script', async () => {
    const res = await request(app).get('/js/github-app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.text).toContain('loadAppConfig');
    expect(res.text).toContain('toggleMonitoredRepo');
  });

  it('GET /api/dashboard/settings includes autoReviewSettings, enforcementPolicy, and customApiBases', async () => {
    const res = await request(app)
      .get('/api/dashboard/settings')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings).toHaveProperty('autoReviewSettings');
    expect(res.body.settings).toHaveProperty('enforcementPolicy');
    expect(res.body.settings).toHaveProperty('customApiBases');
  });

  it('PUT /api/dashboard/settings updates Auto-Review, Enforcement Policies, and Custom LLM Base URLs', async () => {
    const payload = {
      autoReviewSettings: {
        enabled: true,
        triggers: ['pr_opened', '@ct-review'],
        review_drafts: true,
        labels: ['ct-review'],
        ignore_patterns: ['*.md', 'docs/**'],
      },
      enforcementPolicy: {
        require_all_reviews: true,
        failure_action: 'quarantine',
        require_ticket_link: true,
      },
      customApiBases: {
        omniroute_base_url: 'http://omniroute.internal:8000',
        openai_base_url: 'http://openai-proxy.internal/v1',
      },
    };

    const res = await request(app)
      .put('/api/dashboard/settings')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings.autoReviewSettings.review_drafts).toBe(true);
    expect(res.body.settings.autoReviewSettings.labels).toEqual(['ct-review']);
    expect(res.body.settings.enforcementPolicy.failure_action).toBe('quarantine');
    expect(res.body.settings.customApiBases.omniroute_base_url).toBe('http://omniroute.internal:8000');
  });
});
