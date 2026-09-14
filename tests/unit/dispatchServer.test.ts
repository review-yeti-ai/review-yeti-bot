import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';

function createApp(options: { ready?: boolean } = {}) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => options.ready ?? true),
    allowAppGate: false,
  });
}

describe('Action dispatch server endpoints', () => {
  describe('GET / (root operational status landing page)', () => {
    it('returns HTTP 200 OK with JSON operational payload by default', async () => {
      const response = await request(createApp()).get('/');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'review-yeti-action-dispatch',
        health: '/health',
        ready: '/ready',
        landing: 'https://review-bot.calltelemetry.com',
      });
      expect(typeof response.body.timestamp).toBe('string');
    });

    it('returns HTTP 200 OK with HTML landing page when Accept: text/html is requested', async () => {
      const response = await request(createApp())
        .get('/')
        .set('Accept', 'text/html');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text).toContain('Review Yeti Action Dispatch');
      expect(response.text).toContain('Operational (200 OK)');
      expect(response.text).toContain('review-yeti-action-dispatch');
      expect(response.text).toContain('href="/health"');
      expect(response.text).toContain('href="/ready"');
    });

    it('returns HTTP 200 OK with JSON when Accept: application/json is requested', async () => {
      const response = await request(createApp())
        .get('/')
        .set('Accept', 'application/json');
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('review-yeti-action-dispatch');
      expect(response.body.health).toBe('/health');
    });
  });

  describe('GET /health and GET /ready', () => {
    it('returns 200 for /health', async () => {
      const response = await request(createApp()).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('review-yeti-action-dispatch');
    });

    it('returns 200 for /ready when database is ready', async () => {
      const response = await request(createApp({ ready: true })).get('/ready');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ready');
      expect(response.body.databaseReady).toBe(true);
    });

    it('returns 503 for /ready when database is not ready', async () => {
      const response = await request(createApp({ ready: false })).get('/ready');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.databaseReady).toBe(false);
    });
  });
});
