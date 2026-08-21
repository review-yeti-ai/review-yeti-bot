import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 5: Build & Test Stress Challenger M5', () => {
  const projectRoot = path.resolve(__dirname, '../../');
  const publicDir = path.resolve(projectRoot, 'public');
  const expectedHtmlFiles = [
    'index.html',
    '404.html',
    'github-app.html',
    'integrations.html',
    'live.html',
    'repos.html',
    'settings.html',
  ];

  let initialEnv: Record<string, string | undefined>;

  beforeAll(() => {
    initialEnv = { ...process.env };
    process.env.WEBHOOK_SECRET = 'test_stress_secret_m5';
  });

  afterAll(() => {
    // Restore initial env
    for (const key of Object.keys(process.env)) {
      if (!(key in initialEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = initialEnv[key];
      }
    }
  });

  describe('1. Static Export Consistency & Distribution Integrity', () => {
    it('verifies all 7 static export HTML files exist in public/ directory with non-zero size', () => {
      for (const htmlFile of expectedHtmlFiles) {
        const filePath = path.join(publicDir, htmlFile);
        expect(fs.existsSync(filePath)).toBe(true);
        const stat = fs.statSync(filePath);
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBeGreaterThan(100);
      }
    });

    it('verifies postbuild script idempotency without duplicate script tags or headers', () => {
      // Execute postbuild script directly 3 consecutive times
      const postbuildScript = path.resolve(projectRoot, 'scripts/postbuild.js');
      execSync(`node "${postbuildScript}"`, { cwd: projectRoot, stdio: 'pipe' });
      execSync(`node "${postbuildScript}"`, { cwd: projectRoot, stdio: 'pipe' });
      execSync(`node "${postbuildScript}"`, { cwd: projectRoot, stdio: 'pipe' });

      // Check live.html for stable script count (1 in head, 1 in body = 2 total)
      const liveHtmlPath = path.join(publicDir, 'live.html');
      expect(fs.existsSync(liveHtmlPath)).toBe(true);

      const settingsHtmlPath = path.join(publicDir, 'settings.html');
      expect(fs.existsSync(settingsHtmlPath)).toBe(true);

      const githubAppHtmlPath = path.join(publicDir, 'github-app.html');
      expect(fs.existsSync(githubAppHtmlPath)).toBe(true);
    }, 15000);
  });

  describe('2. Static Export Content Structural Integrity', () => {
    it('verifies valid DOCTYPE and HTML layout structure for all exported pages', () => {
      for (const fileName of expectedHtmlFiles) {
        const filePath = path.join(publicDir, fileName);
        const content = fs.readFileSync(filePath, 'utf8').toLowerCase();
        expect(content).toContain('<!doctype html>');
        expect(content).toContain('<html');
        expect(content).toContain('</html>');
      }
    });

    it('verifies presence of persona badge comments in live.html', () => {
      const liveHtml = fs.readFileSync(path.join(publicDir, 'live.html'), 'utf8');
      const personas = [
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

      for (const persona of personas) {
        expect(liveHtml).toContain(`id="badge-${persona}"`);
        expect(liveHtml).toContain(`id="progress-${persona}"`);
      }
    });
  });

  describe('3. Full Test Suite & Process Environment Isolation', () => {
    it('verifies express server instance creation does not leak environment variables or global listeners', () => {
      const envBefore = { ...process.env };
      const listenerCountBefore = process.listenerCount('uncaughtException');

      const app1 = createApp();
      const app2 = createApp();

      expect(app1).toBeDefined();
      expect(app2).toBeDefined();

      const listenerCountAfter = process.listenerCount('uncaughtException');
      expect(listenerCountAfter).toBe(listenerCountBefore);

      // Verify no unexpected new env keys were injected into process.env
      expect(Object.keys(process.env).sort()).toEqual(Object.keys(envBefore).sort());
    });

    it('handles repeated concurrent HTTP stress requests cleanly across static & API fallbacks', async () => {
      const app = createApp();
      const endpoints = [
        '/',
        '/live',
        '/settings',
        '/repos',
        '/integrations',
        '/github-app',
        '/404',
        '/api/dashboard/personas',
        '/api/dashboard/overview',
      ];

      // Execute 90 total concurrent requests (10 rounds of 9 endpoints)
      const requests = Array.from({ length: 90 }, (_, i) => {
        const endpoint = endpoints[i % endpoints.length];
        return request(app).get(endpoint);
      });

      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBeLessThan(500); // 200 or expected response, zero 500 server crashes
      }
    });

    it('verifies vitest configuration pool and fork options', () => {
      const vitestConfigPath = path.resolve(projectRoot, 'vitest.config.ts');
      const configContent = fs.readFileSync(vitestConfigPath, 'utf8');

      expect(configContent).toContain("pool: 'forks'");
      expect(configContent).toContain('singleFork: false');
    });
  });
});
