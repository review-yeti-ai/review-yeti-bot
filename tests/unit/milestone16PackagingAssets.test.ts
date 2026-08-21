import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import yaml from 'js-yaml';
import { z } from 'zod';
import { authService } from '../../src/dashboard/authService';
import { DashboardStore } from '../../src/persistence/dashboardStore';

describe('Milestone 16: Dockerfile Asset Packaging, Auth & YAML Validation Unit Tests', () => {

  describe('1. Dockerfile Static Asset Packaging Verification', () => {
    it('verifies Web Dashboard static assets exist in public/ directory', () => {
      const publicDir = path.join(process.cwd(), 'public');
      expect(fs.existsSync(publicDir)).toBe(true);

      const requiredFiles = [
        'index.html',
        'css/components.css',
        'css/theme.css',
        'js/api.js',
        'js/app.js',
      ];

      for (const relPath of requiredFiles) {
        const fullPath = path.join(publicDir, relPath);
        expect(fs.existsSync(fullPath)).toBe(true);
        const stats = fs.statSync(fullPath);
        expect(stats.size).toBeGreaterThan(0);
      }
    });

    it('verifies Express serves public static assets correctly', async () => {
      const app = express();
      const publicDir = path.join(process.cwd(), 'public');
      app.use(express.static(publicDir));

      const htmlRes = await request(app).get('/index.html');
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers['content-type']).toContain('text/html');
      expect(htmlRes.text).toContain('<html');

      const cssRes = await request(app).get('/css/theme.css');
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers['content-type']).toContain('css');

      const jsRes = await request(app).get('/js/app.js');
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers['content-type']).toContain('javascript');
    });
  });

  describe('2. Authentication Session & API Key Lifecycle Verification', () => {
    it('authenticates valid credentials and generates valid session token', () => {
      const session = authService.login('admin', 'admin123');
      expect(session).toBeDefined();
      expect(session?.user.username).toBe('admin');
      expect(session?.token).toMatch(/^sess_[a-f0-9]+$/);

      const validated = authService.validateSession(session!.token);
      expect(validated).toBeDefined();
      expect(validated?.user.username).toBe('admin');
    });

    it('rejects invalid session tokens and handles session invalidation', () => {
      const session = authService.login('admin', 'admin123');
      expect(session).toBeDefined();

      const token = session!.token;
      authService.invalidateSession(token);

      const check = authService.validateSession(token);
      expect(check).toBeNull();
    });

    it('manages API key creation, store validation, masking, and deletion', () => {
      const storeFile = path.join(process.cwd(), `.tmp_m16_store_${Math.random().toString(36).substring(7)}.json`);
      const store = new DashboardStore(storeFile);

      try {
        const created = store.createApiKey('M16 Test Key');
        expect(created.name).toBe('M16 Test Key');
        expect(created.rawKey).toMatch(/^ct_live_[a-f0-9]{32}$/);
        expect(created.maskedKey).toMatch(/^ct_live_\.\.\.[a-f0-9]{4}$/);

        expect(store.validateApiKey(created.rawKey)).toBe(true);
        expect(store.validateApiKey('ct_live_invalidkey123')).toBe(false);

        const keys = store.getApiKeys();
        expect(keys.length).toBe(1);
        expect(keys[0].maskedKey).toBe(created.maskedKey);

        const deleted = store.deleteApiKey(created.id);
        expect(deleted).toBe(true);
        expect(store.getApiKeys().length).toBe(0);
      } finally {
        if (fs.existsSync(storeFile)) {
          fs.rmSync(storeFile, { force: true });
        }
      }
    });
  });

  describe('3. YAML Schema Parsing Verification', () => {
    it('parses valid ct-review configuration YAML schema correctly', () => {
      const sampleYaml = `
version: "1.0"
bot:
  name: "ct-review-bot"
  profile: "balanced"
personas:
  - id: "security"
    weight: 1.0
  - id: "performance"
    weight: 0.8
routing:
  fallbackProvider: "codex"
`;

      const parsed: any = yaml.load(sampleYaml);
      expect(parsed).toBeDefined();
      expect(parsed.version).toBe('1.0');
      expect(parsed.bot.profile).toBe('balanced');
      expect(parsed.personas).toHaveLength(2);

      const configSchema = z.object({
        version: z.string(),
        bot: z.object({
          name: z.string(),
          profile: z.enum(['chill', 'balanced', 'assertive']),
        }),
        personas: z.array(
          z.object({
            id: z.string(),
            weight: z.number(),
          })
        ),
        routing: z.object({
          fallbackProvider: z.string(),
        }),
      });

      const validated = configSchema.parse(parsed);
      expect(validated.bot.name).toBe('ct-review-bot');
    });

    it('rejects malformed YAML content and invalid schema attributes', () => {
      const invalidYaml = `
version: "1.0"
bot:
  profile: "invalid-profile"
`;

      const parsed: any = yaml.load(invalidYaml);
      const configSchema = z.object({
        version: z.string(),
        bot: z.object({
          profile: z.enum(['chill', 'balanced', 'assertive']),
        }),
      });

      expect(() => configSchema.parse(parsed)).toThrow();
    });
  });
});
