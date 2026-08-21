import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/app';

describe('Milestone 4 Empirical Challenger: Express Static Serving & Middleware Harness', () => {
  let app: any;
  const testAssetDir = path.join(__dirname, '../../public/_next/static/chunks');
  const testAssetPath = path.join(testAssetDir, 'empirical-test-bundle.js');
  let createdTestAssetDir = false;
  let createdTestAssetFile = false;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret_empirical_m4';
    app = createApp();

    // Ensure _next/static test file exists to test express.static setHeaders for immutable assets
    if (!fs.existsSync(testAssetDir)) {
      fs.mkdirSync(testAssetDir, { recursive: true });
      createdTestAssetDir = true;
    }
    if (!fs.existsSync(testAssetPath)) {
      fs.writeFileSync(testAssetPath, 'console.log("empirical test bundle");');
      createdTestAssetFile = true;
    }
  });

  afterAll(() => {
    // Cleanup temporary test asset file if created by this test harness
    if (createdTestAssetFile && fs.existsSync(testAssetPath)) {
      try {
        fs.unlinkSync(testAssetPath);
      } catch (_) {}
    }
  });

  describe('1. API Precedence Verification', () => {
    it('GET /health routes to health API and returns JSON without HTML fallback interference', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('service', 'ct-review-bot');
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });

    it('GET /metrics routes to Prometheus metrics endpoint without fallback interference', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });

    it('GET /api/version routes to version API and returns JSON without fallback interference', async () => {
      const res = await request(app).get('/api/version');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('success', true);
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });

    it('GET /api/about routes to about API and returns JSON without fallback interference', async () => {
      const res = await request(app).get('/api/about');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('success', true);
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });

    it('Unauthenticated GET /api/dashboard/overview returns JSON auth error without HTML fallback', async () => {
      const res = await request(app).get('/api/dashboard/overview');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('error');
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });

    it('POST /webhook returns webhook JSON response without fallback interference', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('x-github-event', 'ping')
        .send({ zen: 'Non-blocking is better than blocking.' });
      
      // Should hit webhook router, returning JSON 401 due to missing signature header, not index.html SPA fallback
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('error', 'Invalid or missing signature');
      expect(res.text).not.toContain('<!DOCTYPE html>');
    });
  });

  describe('2. HTTP Cache-Control Headers Verification', () => {
    it('GET /_next/static/... asset returns public, max-age=31536000, immutable Cache-Control', async () => {
      const res = await request(app).get('/_next/static/chunks/empirical-test-bundle.js');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.text).toContain('empirical test bundle');
    });

    it('GET / returns no-cache, no-store, must-revalidate Cache-Control for root HTML', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('GET /live returns no-cache, no-store, must-revalidate Cache-Control', async () => {
      const res = await request(app).get('/live');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('GET /settings returns no-cache, no-store, must-revalidate Cache-Control', async () => {
      const res = await request(app).get('/settings');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('GET /repos returns no-cache, no-store, must-revalidate Cache-Control', async () => {
      const res = await request(app).get('/repos');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('GET /integrations returns no-cache, no-store, must-revalidate Cache-Control', async () => {
      const res = await request(app).get('/integrations');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });

    it('GET /github-app returns no-cache, no-store, must-revalidate Cache-Control', async () => {
      const res = await request(app).get('/github-app');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });
  });

  describe('3. SPA Route Navigation & Static Export Verification', () => {
    it('GET /live delivers public/live.html static export', async () => {
      const res = await request(app).get('/live');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('Live Agent Stream');
    });

    it('GET /settings delivers public/settings.html static export', async () => {
      const res = await request(app).get('/settings');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('Persona');
    });

    it('GET /repos delivers public/repos.html static export', async () => {
      const res = await request(app).get('/repos');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });

    it('GET /integrations delivers public/integrations.html static export', async () => {
      const res = await request(app).get('/integrations');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });

    it('GET /github-app delivers public/github-app.html static export', async () => {
      const res = await request(app).get('/github-app');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.text).toContain('github-app.js');
    });

    it('Legacy /dashboard/* route aliases deliver respective HTML files', async () => {
      const liveRes = await request(app).get('/dashboard/live');
      expect(liveRes.status).toBe(200);
      expect(liveRes.headers['content-type']).toMatch(/html/);

      const settingsRes = await request(app).get('/dashboard/settings');
      expect(settingsRes.status).toBe(200);
      expect(settingsRes.headers['content-type']).toMatch(/html/);

      const githubRes = await request(app).get('/dashboard/github-app');
      expect(githubRes.status).toBe(200);
      expect(githubRes.headers['content-type']).toMatch(/html/);
    });
  });

  describe('4. Catch-All Fallback Routing Verification', () => {
    it('Unknown GET /unknown-spa-route delivers index.html fallback', async () => {
      const res = await request(app).get('/unknown-spa-route');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(res.text).toContain('CT-Review-Bot');
    });

    it('Unknown nested GET /dashboard/custom/nested/path delivers index.html fallback', async () => {
      const res = await request(app).get('/dashboard/custom/nested/path');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(res.text).toContain('CT-Review-Bot');
    });

    it('Unknown GET route with query parameters delivers index.html fallback', async () => {
      const res = await request(app).get('/deep-link?tab=active&filter=all');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(res.text).toContain('CT-Review-Bot');
    });
  });
});
