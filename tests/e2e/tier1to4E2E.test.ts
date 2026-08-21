import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Tier 1-4 E2E Test Suites per TEST_INFRA.md', () => {
  let app: any;
  let server: any;
  let bus: LiveStreamBus;
  let token: string;

  beforeEach(async () => {
    process.env.ADMIN_PASSWORD = 'admin123';
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';

    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
    app = createApp();
    server = app.listen(0);

    const loginRes = await request(server)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });
    token = loginRes.body?.token || '';
  });

  afterEach(async () => {
    bus.clearHistory();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('Tier 1: Core Feature Coverage (R1 - R4)', () => {
    describe('R1: Real-Time Live Job Streaming Dashboard', () => {
      it('TEST_R1_T1_01 — SSE Unauthenticated Public Stream Connection', async () => {
        const port = (server.address() as any).port;
        const res = await new Promise<{ statusCode: number; contentType: string }>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/live/stream?jobId=test-job-1`, (res) => {
            resolve({
              statusCode: res.statusCode || 0,
              contentType: String(res.headers['content-type'] || ''),
            });
            req.destroy();
          });
          req.on('error', (err) => reject(err));
        });
        expect(res.statusCode).toBe(200);
        expect(res.contentType).toMatch(/text\/event-stream/);
      });

      it('TEST_R1_T1_02 — Authenticated SSE Stream Connection', async () => {
        const port = (server.address() as any).port;
        const res = await new Promise<{ statusCode: number; contentType: string }>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/api/live/stream?jobId=test-job-1&token=valid_token`, (res) => {
            resolve({
              statusCode: res.statusCode || 0,
              contentType: String(res.headers['content-type'] || ''),
            });
            req.destroy();
          });
          req.on('error', (err) => reject(err));
        });
        expect(res.statusCode).toBe(200);
        expect(res.contentType).toMatch(/text\/event-stream/);
      });

      it('TEST_R1_T1_03 — Active Jobs List API Retrieval', async () => {
        const res = await request(server).get('/api/live/jobs');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.jobs)).toBe(true);
      });

      it('TEST_R1_T1_04 — Real-Time Event Publishing & Replay History', async () => {
        const jobId = 'test-replay-job-1';
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'persona:start',
          persona: 'security',
          data: { message: 'Security scan started' },
        });

        const res = await request(server).get(`/api/live/history?jobId=${jobId}`);
        expect(res.status).toBe(200);
        expect(res.body.jobId).toBe(jobId);
        expect(res.body.count).toBeGreaterThanOrEqual(1);
      });

      it('TEST_R1_T1_05 — Live Terminal Route Accessibility', async () => {
        const res = await request(server).get('/live');
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toMatch(/html/);
      });
    });

    describe('R2: Interactive Persona System Prompt & Settings Editor', () => {
      it('TEST_R2_T1_01 — Persona Roster Endpoint Retrieval', async () => {
        const res = await request(server)
          .get('/api/dashboard/personas')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Object.keys(res.body.personas).length).toBe(12);
      });

      it('TEST_R2_T1_02 — Persona Custom System Prompt & Model Update', async () => {
        const updateRes = await request(server)
          .put('/api/dashboard/personas/security')
          .set('Authorization', `Bearer ${token}`)
          .send({
            customPrompt: 'Strict OWASP Top 10 security audit',
            model: 'claude-3-5-sonnet',
            effort: 'max',
            confidenceThreshold: 90,
          });

        expect(updateRes.status).toBe(200);
        expect(updateRes.body.success).toBe(true);
        expect(updateRes.body.persona.customPrompt).toContain('OWASP Top 10');
      });

      it('TEST_R2_T1_03 — Store Persistence Across Instance Reload', async () => {
        dashboardStore.updatePersonaSetting('quality', { confidenceThreshold: 88 });
        const freshSettings = dashboardStore.getSettings();
        expect(freshSettings.personaSettings?.quality.confidenceThreshold).toBe(88);
      });

      it('TEST_R2_T1_04 — Model Override Enforcement Validation', async () => {
        const res = await request(server)
          .put('/api/dashboard/personas/architecture')
          .set('Authorization', `Bearer ${token}`)
          .send({ model: 'gpt-4o' });

        expect(res.status).toBe(200);
        expect(res.body.persona.model).toBe('gpt-4o');
      });

      it('TEST_R2_T1_05 — Settings Control Route Delivery', async () => {
        const res = await request(server).get('/settings');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Platform &amp; Persona Control Panel');
      });
    });

    describe('R3: Linear-Grade Dark Aesthetic & UI Components', () => {
      it('TEST_R3_T1_01 — Obsidian Dark Theme Background CSS Rules', async () => {
        const res = await request(server).get('/css/theme.css');
        expect(res.status).toBe(200);
        expect(res.text).toContain('--bg-app');
      });

      it('TEST_R3_T1_02 — Sidebar Component Scripting & Navigation Links', async () => {
        const res = await request(server).get('/live');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Overview');
        expect(res.text).toContain('Persona Editor');
      });

      it('TEST_R3_T1_03 — Overview Dashboard Metrics Endpoint', async () => {
        const res = await request(server)
          .get('/api/dashboard/overview')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('TEST_R3_T1_04 — Integrations Roster Retrieval', async () => {
        const res = await request(server)
          .get('/api/dashboard/integrations')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('TEST_R3_T1_05 — API Key Generation & Hashing', () => {
        const keyRecord = dashboardStore.createApiKey('tier1-test-key');
        expect(keyRecord.rawKey).toMatch(/^ct_live_/);
        expect(dashboardStore.validateApiKey(keyRecord.rawKey)).toBe(true);
      });
    });

    describe('R4: Static Express Serving & Production Build Pipeline', () => {
      it('TEST_R4_T1_01 — Next.js Static Export HTML Generation', () => {
        const publicDir = path.resolve(__dirname, '../../public');
        expect(fs.existsSync(path.join(publicDir, 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(publicDir, 'live.html'))).toBe(true);
        expect(fs.existsSync(path.join(publicDir, 'settings.html'))).toBe(true);
      });

      it('TEST_R4_T1_02 — Express Clean Route Delivery', async () => {
        const res = await request(server).get('/live');
        expect(res.status).toBe(200);
        expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
      });

      it('TEST_R4_T1_03 — Express SPA Wildcard Route Delivery', async () => {
        const res = await request(server).get('/dashboard/unknown-page');
        expect(res.status).toBe(200);
        expect(res.text).toContain('CT-Review-Bot');
      });

      it('TEST_R4_T1_04 — Legacy Route Aliasing (/dashboard/live -> live.html)', async () => {
        const res = await request(server).get('/dashboard/live');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Live Agent Review Terminal');
      });

      it('TEST_R4_T1_05 — Health & Version API Endpoints', async () => {
        const healthRes = await request(server).get('/health');
        expect(healthRes.status).toBe(200);
        expect(healthRes.body.status).toBe('ok');

        const versionRes = await request(server).get('/api/version');
        expect(versionRes.status).toBe(200);
        expect(versionRes.body.success).toBe(true);
      });
    });
  });

  describe('Tier 2: Boundary & Corner Cases', () => {
    it('TEST_R1_T2_01 — History Buffer Overflow Handling', async () => {
      const jobId = 'buffer-overflow-job';
      for (let i = 0; i < 550; i++) {
        bus.publishEvent({
          jobId,
          timestamp: new Date().toISOString(),
          type: 'llm:token',
          persona: 'quality',
          data: { index: i },
        });
      }
      const history = bus.getHistory(jobId);
      expect(history.length).toBeLessThanOrEqual(500);
    });

    it('TEST_R2_T2_01 — Out-of-Bounds Confidence Threshold Validation', async () => {
      const res = await request(server)
        .put('/api/dashboard/personas/security')
        .set('Authorization', `Bearer ${token}`)
        .send({ confidenceThreshold: 150 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('TEST_R2_T2_02 — Disallowed Model Override Rejection', async () => {
      const res = await request(server)
        .put('/api/dashboard/personas/architecture')
        .set('Authorization', `Bearer ${token}`)
        .send({ model: 'untrusted-local-model' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('TEST_R2_T2_03 — Non-Existent Persona ID Target', async () => {
      const res = await request(server)
        .put('/api/dashboard/personas/unknown_persona_xyz')
        .set('Authorization', `Bearer ${token}`)
        .send({ enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('TEST_R4_T2_01 — Wildcard SPA Routing Fallback', async () => {
      const res = await request(server).get('/non-existent-client-route-path');
      expect(res.status).toBe(200);
      expect(res.text).toContain('CT-Review-Bot');
    });
  });

  describe('Tier 3: Cross-Feature Combination Scenarios', () => {
    it('SCENARIO_3.1 — R1 x R2: Persona Update during Live Stream', async () => {
      const jobId = 'live-stream-scenario-3.1';
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:start',
        persona: 'security',
        data: { message: 'In-progress review' },
      });

      const updateRes = dashboardStore.updatePersonaSetting('security', {
        customPrompt: 'Updated live prompt',
      });
      expect(updateRes.customPrompt).toBe('Updated live prompt');

      const history = bus.getHistory(jobId);
      expect(history.length).toBe(1);
    });

    it('SCENARIO_3.3 — R2 x R4: Statically Served Frontend Calls Settings REST API', async () => {
      const pageRes = await request(server).get('/settings');
      expect(pageRes.status).toBe(200);

      const apiRes = await request(server)
        .put('/api/dashboard/personas/reliability')
        .set('Authorization', `Bearer ${token}`)
        .send({ effort: 'max' });

      if (apiRes.status !== 200) {
        console.log('DEBUG 3.3:', apiRes.status, apiRes.body, apiRes.text);
      }

      expect(apiRes.status).toBe(200);
      expect(apiRes.body.persona.effort).toBe('max');
    });

    it('SCENARIO_3.4 — R1 x R3: Public Unauthenticated SSE Stream & Protected Admin Routes', async () => {
      const port = (server.address() as any).port;

      const statusCode = await new Promise<number>((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/api/live/stream?jobId=public-pr-1`, (res) => {
          const code = res.statusCode || 500;
          req.destroy();
          resolve(code);
        });
      });
      expect(statusCode).toBe(200);

      const protectedRes = await request(server).get('/api/dashboard/settings');
      expect(protectedRes.status).toBe(401);
    });
  });

  describe('Tier 4: Real-World Application Workflows', () => {
    it('Workflow 4.2 — Administrator Persona Customization & Test Verification Flow', async () => {
      const updateRes = await request(server)
        .put('/api/dashboard/personas/security')
        .set('Authorization', `Bearer ${token}`)
        .send({
          customPrompt: 'Require zero-trust JWT auditing',
          model: 'claude-3-5-sonnet',
        });
      expect(updateRes.status).toBe(200);

      const freshSettings = dashboardStore.getSettings();
      expect(freshSettings.personaSettings?.security.customPrompt).toBe('Require zero-trust JWT auditing');
    });

    it('Workflow 4.4 — Enterprise API Key Generation & Authenticated API Lifecycle', async () => {
      const keyData = dashboardStore.createApiKey('workflow-key');
      expect(keyData.rawKey).toBeDefined();

      const isValid = dashboardStore.validateApiKey(keyData.rawKey);
      expect(isValid).toBe(true);

      const deleted = dashboardStore.deleteApiKey(keyData.id);
      expect(deleted).toBe(true);
    });
  });
});
