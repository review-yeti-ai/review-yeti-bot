import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createScratchOwner } from '../support/scratch-lifecycle';
import os from 'node:os';
import request from 'supertest';
import { createApp } from '../../src/app';
import { assertLiveMarkup } from '../support/dashboardMarkup';

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

    it("packages idempotently in an owned fixture without rewriting another test's served assets", () => {
      const scratch = createScratchOwner({ parentDir: process.env.CT_REVIEW_TEST_SCRATCH_ROOT || os.tmpdir(),
        prefix: 'dashboard-packaging-', kind: 'dashboard-packaging-fixture' });
      try {
        fs.mkdirSync(path.join(scratch.path, 'scripts'));
        for (const script of ['postbuild.js', 'ensure-static-assets.js']) {
          fs.copyFileSync(path.join(projectRoot, 'scripts', script), path.join(scratch.path, 'scripts', script));
        }
        fs.cpSync(path.join(projectRoot, 'legacy_public'), path.join(scratch.path, 'legacy_public'), { recursive: true });
        // Use the actual export bytes; this test owns its distribution directories.
        fs.cpSync(publicDir, path.join(scratch.path, 'out'), { recursive: true });
        const run = () => execFileSync(process.execPath, [path.join(scratch.path, 'scripts/postbuild.js')],
          { cwd: scratch.path, stdio: 'pipe' });
        run();
        const first = expectedHtmlFiles.map((file) => fs.readFileSync(path.join(scratch.path, 'public', file), 'utf8'));
        run(); run();
        expectedHtmlFiles.forEach((file, index) => {
          expect(fs.readFileSync(path.join(scratch.path, 'public', file), 'utf8')).toBe(first[index]);
          expect(fs.readFileSync(path.join(scratch.path, 'dist/public', file), 'utf8')).toBe(first[index]);
        });
      } finally { scratch.cleanup(); }
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

    it('preserves the hydratable live swarm route after repeated packaging', () => {
      const liveHtml = fs.readFileSync(path.join(publicDir, 'live.html'), 'utf8');
      assertLiveMarkup(liveHtml);
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
      // REL-560: parallel files, still one isolated fork per file.
      expect(configContent).toContain('fileParallelism: true');
      expect(configContent).toContain('isolate: true');
      expect(configContent).not.toContain('poolOptions');
      expect(configContent).not.toContain('singleFork');
    });
  });
});
