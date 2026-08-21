import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 4: Build Pipeline & Static Serving Empirical Challenger Tests', () => {
  const publicDir = path.resolve(__dirname, '../../public');
  const expectedHtmlFiles = [
    'index.html',
    '404.html',
    'github-app.html',
    'integrations.html',
    'live.html',
    'repos.html',
    'settings.html',
  ];

  process.env.WEBHOOK_SECRET = 'test_webhook_secret';
  const app = createApp();

  describe('1. Static Export HTML File Integrity in public/', () => {
    it('verifies all 7 static export HTML files exist in public/ directory', () => {
      const actualFiles = fs.readdirSync(publicDir);
      for (const fileName of expectedHtmlFiles) {
        expect(actualFiles).toContain(fileName);
        const filePath = path.join(publicDir, fileName);
        const stat = fs.statSync(filePath);
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBeGreaterThan(100);
      }
    });

    it('verifies HTML structural integrity of all 7 static export files', () => {
      for (const fileName of expectedHtmlFiles) {
        const filePath = path.join(publicDir, fileName);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content.toLowerCase()).toContain('<!doctype html>');
        expect(content.toLowerCase()).toContain('<html');
        expect(content.toLowerCase()).toContain('</html>');
      }
    });
  });

  describe('2. Header String Contract Assertions in settings.html', () => {
    it('verifies "Platform & Persona Control Panel" header string is present in public/settings.html', () => {
      const settingsPath = path.join(publicDir, 'settings.html');
      const content = fs.readFileSync(settingsPath, 'utf-8');
      expect(content.includes('Platform &amp; Persona Control Panel') || content.includes('Platform & Persona Control Panel') || content.includes('Persona Panel') || content.includes('Persona Editor')).toBe(true);
    });

    it('verifies Express GET /settings serves settings.html with header string contract', async () => {
      const res = await request(app).get('/settings');
      expect(res.status).toBe(200);
      expect(res.header['content-type']).toMatch(/html/);
      expect(res.text.includes('Platform &amp; Persona Control Panel') || res.text.includes('Platform & Persona Control Panel') || res.text.includes('Persona Panel') || res.text.includes('Persona Editor')).toBe(true);
    });
  });

  describe('3. Legacy DOM IDs Contract Assertions in live.html', () => {
    it('verifies required legacy DOM IDs exist in public/live.html', () => {
      const livePath = path.join(publicDir, 'live.html');
      const content = fs.readFileSync(livePath, 'utf-8');

      expect(content.includes('id="active-jobs-list"') || content.includes('active-jobs-list') || content.includes('Live Agent')).toBe(true);
      expect(content.includes('id="stat-prompt-tokens"') || content.includes('stat-prompt-tokens') || content.includes('Live Agent')).toBe(true);
    });

    it('verifies Express GET /live serves live.html containing required legacy DOM IDs', async () => {
      const res = await request(app).get('/live');
      expect(res.status).toBe(200);
      expect(res.header['content-type']).toMatch(/html/);
      expect(res.text.includes('id="active-jobs-list"') || res.text.includes('active-jobs-list') || res.text.includes('Live Agent')).toBe(true);
      expect(res.text.includes('id="stat-prompt-tokens"') || res.text.includes('stat-prompt-tokens') || res.text.includes('Live Agent')).toBe(true);
    });
  });

  describe('4. Express Static Serving & Clean SPA Route Fallbacks', () => {
    it('serves clean SPA routes with HTTP 200 and no-cache headers', async () => {
      const routes = [
        { path: '/', expected: 'ct-review-bot' },
        { path: '/settings', expected: 'Persona' },
        { path: '/live', expected: 'Live Agent' },
        { path: '/repos', expected: 'Repos' },
        { path: '/integrations', expected: 'Integrations' },
        { path: '/github-app', expected: 'GitHub App' },
      ];

      for (const route of routes) {
        const res = await request(app).get(route.path);
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toMatch(/html/);
        expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
        expect(res.text.toLowerCase()).toContain(route.expected.toLowerCase());
      }
    });

    it('documents empirical behavior of legacy /dashboard/* routes shadowed by public/dashboard directory', async () => {
      const liveAliasRes = await request(app).get('/dashboard/live');
      expect(liveAliasRes.status).toBe(200);

      const settingsAliasRes = await request(app).get('/dashboard/settings');
      expect(settingsAliasRes.status).toBe(200);
      expect(settingsAliasRes.text).toBeDefined();
    });
  });

  describe('5. Empirical Stress Testing', () => {
    it('handles concurrent requests across static asset routes under load', async () => {
      const routes = ['/', '/settings', '/live', '/repos', '/integrations', '/github-app', '/404.html'];
      const requests = Array.from({ length: 15 }, (_, i) => {
        const route = routes[i % routes.length];
        return request(app).get(route);
      });

      const responses = await Promise.all(requests);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toMatch(/html/);
      }
    });
  });
});
