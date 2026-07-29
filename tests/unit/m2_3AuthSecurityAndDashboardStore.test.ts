import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import supertest from 'supertest';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../../src/api/authMiddleware';
import { DashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';

describe('Milestone 2 & 3: Auth Security & Test Alignment Verification', () => {
  describe('1. Auth Middleware Strict Path Matching & Substring Attack Prevention', () => {
    let app: Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use(requireAuth);

      // Dummy protected dashboard route
      app.get('/api/dashboard/overview', (_req, res) => {
        res.status(200).json({ success: true, data: 'overview' });
      });

      // Dummy protected auth apikeys route
      app.get('/api/auth/apikeys', (_req, res) => {
        res.status(200).json({ success: true, data: 'keys' });
      });

      // Dummy public route
      app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
      });
    });

    it('blocks sub-path attack attempting to bypass auth via /auth/login substring', async () => {
      const attackUrls = [
        '/api/dashboard/overview?bypass=/auth/login',
        '/api/dashboard/overview/auth/login',
        '/api/dashboard/auth/login/settings',
        '/api/dashboard/overview#auth/login',
      ];

      for (const url of attackUrls) {
        const res = await supertest(app).get(url);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    });

    it('enforces authentication on /api/auth/apikeys', async () => {
      const res = await supertest(app).get('/api/auth/apikeys');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('allows access to legitimate public endpoints with exact path matching', async () => {
      const res = await supertest(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('authenticates successfully with valid bearer token on protected endpoint', async () => {
      const session = authService.login('admin', 'admin123');
      expect(session).toBeDefined();

      const res = await supertest(app)
        .get('/api/dashboard/overview')
        .set('Authorization', `Bearer ${session!.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('2. DashboardStore Persona Merging & Defaults Integrity', () => {
    const tmpStoreFile = path.join(process.cwd(), 'fixtures/tmp/test_m2_3_store.json');

    beforeEach(() => {
      if (fs.existsSync(tmpStoreFile)) {
        fs.unlinkSync(tmpStoreFile);
      }
    });

    afterEach(() => {
      try {
        if (fs.existsSync(tmpStoreFile)) {
          fs.unlinkSync(tmpStoreFile);
        }
      } catch {}
    });

    it('cleanly merges default persona attributes when loading partial persona overrides from disk', () => {
      // Write partial persona setting to disk
      const dir = path.dirname(tmpStoreFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const partialData = {
        repositories: [],
        settings: {
          personaSettings: {
            security: {
              confidenceThreshold: 99,
              customPrompt: 'Zero tolerance for unhandled exceptions',
            },
          },
        },
      };

      fs.writeFileSync(tmpStoreFile, JSON.stringify(partialData, null, 2), 'utf8');

      // Instantiate DashboardStore with the partial file
      const store = new DashboardStore(tmpStoreFile);
      const settings = store.getSettings();

      expect(settings.personaSettings).toBeDefined();
      const security = settings.personaSettings!['security'];
      expect(security).toBeDefined();
      // Overridden fields
      expect(security.confidenceThreshold).toBe(99);
      expect(security.customPrompt).toBe('Zero tolerance for unhandled exceptions');
      // Preserved default fields
      expect(security.id).toBe('security');
      expect(security.displayName).toContain('Security');
      expect(security.enabled).toBe(true);
      expect(security.required).toBe(true);
      expect(security.model).toBe('claude-3-5-sonnet');
      expect(security.charter).toBe('builtin:security');
      expect(security.paths).toEqual(['**/*']);
      expect(security.providers).toEqual(['claude', 'codex']);

      // Ensure other default personas were also loaded with defaults intact
      const architecture = settings.personaSettings!['architecture'];
      expect(architecture).toBeDefined();
      expect(architecture.displayName).toContain('Architecture');
      expect(architecture.enabled).toBe(true);
    });

    it('helper methods getPersonaSettings() and getPersonaSetting() return clean merged data', () => {
      const store = new DashboardStore(tmpStoreFile);
      const allPersonas = store.getPersonaSettings();
      expect(Object.keys(allPersonas).length).toBeGreaterThanOrEqual(11);

      const perf = store.getPersonaSetting('performance');
      expect(perf).toBeDefined();
      expect(perf?.id).toBe('performance');
      expect(perf?.displayName).toContain('Performance');
      expect(perf?.confidenceThreshold).toBe(70);
    });

    it('updates persona settings without losing default attributes', () => {
      const store = new DashboardStore(tmpStoreFile);
      store.updatePersonaSetting('quality', {
        confidenceThreshold: 88,
        customPrompt: 'Strict lint check',
      });

      const quality = store.getPersonaSetting('quality');
      expect(quality?.confidenceThreshold).toBe(88);
      expect(quality?.customPrompt).toBe('Strict lint check');
      expect(quality?.displayName).toContain('Quality');
      expect(quality?.model).toBe('claude-3-5-sonnet');
    });
  });
});
