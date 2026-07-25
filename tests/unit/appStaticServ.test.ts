import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Milestone 14: Express Static & SPA Fallback Routing', () => {
  process.env.WEBHOOK_SECRET = 'test_webhook_secret';
  const app = createApp();

  it('GET / serves index.html static SPA shell', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.text).toContain('CT-Review-Bot');
  });

  it('GET /css/theme.css serves static CSS theme tokens', async () => {
    const res = await request(app).get('/css/theme.css');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/css/);
    expect(res.text).toContain('--bg-app: hsl(220, 15%, 8%)');
  });

  it('GET /js/app.js serves static SPA client script', async () => {
    const res = await request(app).get('/js/app.js');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('ApiClient.getSession()');
  });

  it('SPA Fallback: non-API GET /dashboard/repositories falls back to index.html', async () => {
    const res = await request(app).get('/dashboard/repositories');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/html/);
    expect(res.text).toContain('CT-Review-Bot');
  });
});
