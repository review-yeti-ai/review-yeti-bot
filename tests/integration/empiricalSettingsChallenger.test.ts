import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createApp } from '../../src/app';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';

describe('Challenger 2: Settings REST API & Control Panel Web UI Stress Test Harness (Milestones 38 & 40)', () => {
  let app: any;
  let validApiKey: string;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
  });

  beforeEach(() => {
    app = createApp();
    const createdKey = dashboardStore.createApiKey('challenger2-settings-key');
    validApiKey = createdKey.rawKey;
  });

  describe('1. REST API Boundary Validation & Error Handling', () => {
    it('rejects confidenceThreshold out-of-bounds (< 0 e.g. -10)', async () => {
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: -10 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/confidenceThreshold/i);
    });

    it('rejects confidenceThreshold out-of-bounds (> 100 e.g. 105)', async () => {
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 105 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/confidenceThreshold/i);
    });

    it('rejects confidenceThreshold NaN / Infinity / non-numeric string', async () => {
      const res1 = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 'invalid-string' });

      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: NaN });

      expect(res2.status).toBe(400);

      const res3 = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: Infinity });

      expect(res3.status).toBe(400);
    });

    it('accepts exact boundary values 0 and 100 for confidenceThreshold', async () => {
      const resLow = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 0 });

      expect(resLow.status).toBe(200);
      expect(resLow.body.persona.confidenceThreshold).toBe(0);

      const resHigh = await request(app)
        .patch('/api/dashboard/settings/personas/security')
        .set('x-api-key', validApiKey)
        .send({ confidenceThreshold: 100 });

      expect(resHigh.status).toBe(200);
      expect(resHigh.body.persona.confidenceThreshold).toBe(100);
    });

    it('rejects invalid effort strings (e.g. "ultra", "super", empty, numeric)', async () => {
      const invalidEfforts = ['ultra', 'super', '', 123, null];
      for (const eff of invalidEfforts) {
        const res = await request(app)
          .patch('/api/dashboard/settings/personas/architecture')
          .set('x-api-key', validApiKey)
          .send({ effort: eff });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/effort/i);
      }
    });

    it('accepts all valid effort levels: low, medium, high, max', async () => {
      const validEfforts: Array<'low' | 'medium' | 'high' | 'max'> = ['low', 'medium', 'high', 'max'];
      for (const eff of validEfforts) {
        const res = await request(app)
          .patch('/api/dashboard/settings/personas/architecture')
          .set('x-api-key', validApiKey)
          .send({ effort: eff });

        expect(res.status).toBe(200);
        expect(res.body.persona.effort).toBe(eff);
      }
    });

    it('rejects empty or whitespace-only model IDs', async () => {
      const invalidModels = ['', '   ', null, 123];
      for (const mod of invalidModels) {
        const res = await request(app)
          .patch('/api/dashboard/settings/personas/performance')
          .set('x-api-key', validApiKey)
          .send({ model: mod });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/model/i);
      }
    });

    it('rejects non-boolean enabled flag', async () => {
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/performance')
        .set('x-api-key', validApiKey)
        .send({ enabled: 'true' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled/i);
    });

    it('returns 404 for nonexistent personaId', async () => {
      const res = await request(app)
        .patch('/api/dashboard/settings/personas/unknown_persona_999')
        .set('x-api-key', validApiKey)
        .send({ enabled: false });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('PUT /api/dashboard/settings validates nested personaSettings updates', async () => {
      const res = await request(app)
        .put('/api/dashboard/settings')
        .set('x-api-key', validApiKey)
        .send({
          personaSettings: {
            security: {
              confidenceThreshold: -99, // invalid!
            },
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/confidenceThreshold/i);
    });
  });

  describe('2. Atomic Persona Settings Persistence & Concurrent API Updates', () => {
    const testDbPath = path.join('/tmp', 'ct-review-bot', `concurrent_test_${Date.now()}.json`);

    beforeEach(() => {
      if (fs.existsSync(testDbPath)) {
        try { fs.unlinkSync(testDbPath); } catch {}
      }
    });

    it('handles 60 concurrent PATCH updates atomically without file corruption', async () => {
      const customStore = new DashboardStore(testDbPath);
      const personas = [
        'security', 'architecture', 'performance', 'quality', 'database',
        'api_contract', 'reliability', 'devops', 'docs_compliance', 'finops'
      ];

      // Prepare 60 concurrent update tasks
      const requests = Array.from({ length: 60 }).map((_, idx) => {
        const personaId = personas[idx % personas.length];
        const newThreshold = 50 + (idx % 50);
        const effortChoice = (['low', 'medium', 'high', 'max'] as const)[idx % 4];
        return Promise.resolve().then(() => {
          return customStore.updatePersonaSetting(personaId, {
            confidenceThreshold: newThreshold,
            effort: effortChoice,
            enabled: idx % 2 === 0,
          });
        });
      });

      const results = await Promise.allSettled(requests);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(60);

      // Verify file contents on disk
      expect(fs.existsSync(testDbPath)).toBe(true);
      const raw = fs.readFileSync(testDbPath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();

      // Load new store instance to verify atomic state persistence
      const freshStore = new DashboardStore(testDbPath);
      const settings = freshStore.getSettings();
      expect(settings.personaSettings).toBeDefined();
      expect(Object.keys(settings.personaSettings!).length).toBe(10);
    });

    it('maintains state consistency when concurrent valid and invalid requests collide', async () => {
      const customStore = new DashboardStore(testDbPath);

      const validTask1 = Promise.resolve().then(() =>
        customStore.updatePersonaSetting('security', { confidenceThreshold: 92 })
      );
      const invalidTask = Promise.resolve().then(() =>
        customStore.updatePersonaSetting('security', { confidenceThreshold: 999 })
      );
      const validTask2 = Promise.resolve().then(() =>
        customStore.updatePersonaSetting('security', { effort: 'max' })
      );

      const results = await Promise.allSettled([validTask1, invalidTask, validTask2]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');

      const freshStore = new DashboardStore(testDbPath);
      const secPersona = freshStore.getSettings().personaSettings?.security;
      expect(secPersona?.effort).toBe('max');
      expect(secPersona?.confidenceThreshold).toBe(92);
    });
  });

  describe('3. Linear Dark Theme Web UI Structure & Roster Verification', () => {
    const htmlPath = path.join(__dirname, '../../public/settings.html');
    const jsPath = path.join(__dirname, '../../public/js/settings.js');

    it('verifies settings.html includes mandatory DOM elements and dark theme assets', () => {
      expect(fs.existsSync(htmlPath)).toBe(true);
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');

      // Check dark theme stylesheets
      expect(htmlContent).toContain('/css/theme.css');
      expect(htmlContent).toContain('/css/components.css');

      // Check key layout sections & IDs
      expect(htmlContent).toContain('Per-Persona Control Panel');
      expect(htmlContent).toContain('10 Domain-Specialized Persona Review Roster');
      expect(htmlContent).toContain('id="active-personas-badge"');
      expect(htmlContent).toContain('id="persona-settings-grid"');
      expect(htmlContent).toContain('id="save-all-btn"');
      expect(htmlContent).toContain('id="reset-defaults-btn"');
      expect(htmlContent).toContain('id="toast-container"');
      expect(htmlContent).toContain('src="/js/settings.js"');
    });

    it('verifies settings.js defines all 10 persona cards, dropdowns, sliders, toggles, and toast alerts', () => {
      expect(fs.existsSync(jsPath)).toBe(true);
      const jsContent = fs.readFileSync(jsPath, 'utf8');

      const requiredPersonas = [
        'security', 'architecture', 'performance', 'quality', 'database',
        'api_contract', 'reliability', 'devops', 'docs_compliance', 'finops'
      ];

      for (const p of requiredPersonas) {
        expect(jsContent).toContain(`id: '${p}'`);
      }

      // Dropdown & Effort options
      expect(jsContent).toContain('AVAILABLE_MODELS');
      expect(jsContent).toContain('EFFORT_LEVELS');
      expect(jsContent).toContain("'low', 'medium', 'high', 'max'");

      // UI Control classnames & elements
      expect(jsContent).toContain('toggle-switch');
      expect(jsContent).toContain('toggle-slider');
      expect(jsContent).toContain('select-control');
      expect(jsContent).toContain('effort-pills');
      expect(jsContent).toContain('effort-pill');
      expect(jsContent).toContain('slider-control');
      expect(jsContent).toContain('slider-value-badge');
      expect(jsContent).toContain('showToast');
    });
  });
});
