import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';

describe('Persona Settings API Endpoints (/api/dashboard/personas)', () => {
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    app = createApp();
    const createdKey = dashboardStore.createApiKey('test-persona-api-key');
    validApiKey = createdKey.rawKey;
  });

  it('GET /api/dashboard/personas returns all 11 personas with default settings', async () => {
    const res = await request(app)
      .get('/api/dashboard/personas')
      .set('x-api-key', validApiKey);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.personas).toBeDefined();

    const personaKeys = Object.keys(res.body.personas);
    expect(personaKeys).toHaveLength(12);
    expect(personaKeys).toEqual(
      expect.arrayContaining([
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
      ])
    );

    const sec = res.body.personas.security;
    expect(sec.id).toBe('security');
    expect(sec.displayName).toBeDefined();
    expect(sec.description).toBeDefined();
    expect(typeof sec.enabled).toBe('boolean');
    expect(sec.model).toBeDefined();
    expect(sec.effort).toBeDefined();
    expect(typeof sec.confidenceThreshold).toBe('number');
    expect(sec.charter).toBe('builtin:security');
    expect(Array.isArray(sec.paths)).toBe(true);
    expect(Array.isArray(sec.providers)).toBe(true);
  });

  it('PUT /api/dashboard/personas/:persona updates valid persona settings and custom prompt', async () => {
    const res = await request(app)
      .put('/api/dashboard/personas/security')
      .set('x-api-key', validApiKey)
      .send({
        enabled: true,
        required: true,
        charter: 'builtin:security',
        customPrompt: 'Always enforce strict OWASP Top 10 guidelines and secret scanning.',
        model: 'claude-3-5-sonnet',
        effort: 'max',
        confidenceThreshold: 90,
        paths: ['src/**'],
        providers: ['claude', 'codex'],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.persona.id).toBe('security');
    expect(res.body.persona.customPrompt).toBe(
      'Always enforce strict OWASP Top 10 guidelines and secret scanning.'
    );
    expect(res.body.persona.confidenceThreshold).toBe(90);

    // Verify GET /api/dashboard/personas reflects the updated custom prompt
    const getRes = await request(app)
      .get('/api/dashboard/personas')
      .set('x-api-key', validApiKey);

    expect(getRes.status).toBe(200);
    expect(getRes.body.personas.security.customPrompt).toBe(
      'Always enforce strict OWASP Top 10 guidelines and secret scanning.'
    );
    expect(getRes.body.personas.security.confidenceThreshold).toBe(90);
  });

  it('PUT /api/dashboard/personas/:persona returns 404 for invalid persona name', async () => {
    const res = await request(app)
      .put('/api/dashboard/personas/non_existent_persona')
      .set('x-api-key', validApiKey)
      .send({
        enabled: true,
        model: 'claude-3-5-sonnet',
        effort: 'high',
        confidenceThreshold: 80,
      });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('non_existent_persona');
  });

  it('PUT /api/dashboard/personas/:persona returns 400 for invalid model override', async () => {
    const res = await request(app)
      .put('/api/dashboard/personas/security')
      .set('x-api-key', validApiKey)
      .send({
        model: 'invalid-unsupported-model-x',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('invalid-unsupported-model-x');
  });

  it('PUT /api/dashboard/personas/:persona returns 400 for invalid confidence threshold out of bounds', async () => {
    const res = await request(app)
      .put('/api/dashboard/personas/security')
      .set('x-api-key', validApiKey)
      .send({
        confidenceThreshold: 150,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('confidenceThreshold');
  });

  it('PUT /api/dashboard/personas/:persona returns 400 for invalid effort level', async () => {
    const res = await request(app)
      .put('/api/dashboard/personas/security')
      .set('x-api-key', validApiKey)
      .send({
        effort: 'ultra-mega',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('effort');
  });
});
