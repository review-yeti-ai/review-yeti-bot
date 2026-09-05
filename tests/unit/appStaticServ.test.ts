import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 4: Express Static & SPA Fallback Routing UI Tests', () => {
  process.env.WEBHOOK_SECRET = 'test_webhook_secret';
  const app = createApp();

  it('GET / serves index.html static SPA shell with no-cache header', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.text).toContain('CT-Review-Bot');
  });

  it('GET /dashboard/live serves public/live.html live stream dashboard', async () => {
    const res = await request(app).get('/dashboard/live');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.text.includes('Live Agent') || res.text.includes('CT-Review-Bot') || res.text.includes('/_next/static/')).toBe(true);
  });

  it('GET /dashboard/settings serves public/settings.html persona control dashboard', async () => {
    const res = await request(app).get('/dashboard/settings');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.text.includes('Persona') || res.text.includes('Platform') || res.text.includes('CT-Review-Bot') || res.text.includes('/_next/static/')).toBe(true);
  });

  it('Clean SPA Route GET /live serves public/live.html', async () => {
    const res = await request(app).get('/live');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('Clean SPA Route GET /settings serves public/settings.html', async () => {
    const res = await request(app).get('/settings');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('Clean SPA Route GET /repos serves public/repos.html', async () => {
    const res = await request(app).get('/repos');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('Clean SPA Route GET /integrations serves public/integrations.html', async () => {
    const res = await request(app).get('/integrations');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('Clean SPA Route GET /github-app serves public/github-app.html', async () => {
    const res = await request(app).get('/github-app');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('Clean SPA Route GET /memory serves public/memory.html', async () => {
    const res = await request(app).get('/memory');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('GET /dashboard/memory serves public/memory.html', async () => {
    const res = await request(app).get('/dashboard/memory');
    if (res.status !== 200) {
      console.log('GET /dashboard/memory failed:', res.status, res.body, JSON.stringify(res.text));
    }
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('GET /css/theme.css serves static Linear dark CSS theme tokens', async () => {
    const res = await request(app).get('/css/theme.css');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/css/);
    expect(res.text).toContain('--bg-app: hsl(220, 15%, 8%)');
    expect(res.text).toContain('--glass-blur: blur(16px)');
  });

  it('GET /css/components.css serves static component styles', async () => {
    const res = await request(app).get('/css/components.css');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/css/);
    expect(res.text).toContain('.glass-panel');
    expect(res.text).toContain('.toggle-switch');
  });

  it('GET /js/live.js serves static live streaming client script', async () => {
    const res = await request(app).get('/js/live.js');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('/api/live/stream');
  });

  it('GET /js/settings.js serves static persona settings client script', async () => {
    const res = await request(app).get('/js/settings.js');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('DEFAULT_PERSONAS_META');
    expect(res.text).toContain('red_team');
  });

  it('Middleware precedence: API /health and /api/version route before static serving', async () => {
    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.header['content-type']).toMatch(/json/);
    expect(healthRes.body.status).toBe('ok');

    const versionRes = await request(app).get('/api/version');
    expect(versionRes.status).toBe(200);
    expect(versionRes.header['content-type']).toMatch(/json/);
    expect(versionRes.body.success).toBe(true);
  });

  it('SPA Fallback: non-API GET /dashboard/repositories falls back to index.html', async () => {
    const res = await request(app).get('/dashboard/repositories');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.header['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.text).toContain('CT-Review-Bot');
  });
});
