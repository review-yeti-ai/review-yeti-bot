import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { DashboardStore, dashboardStore } from '../../src/persistence/dashboardStore';
import { createApp } from '../../src/app';

describe('10-Persona Roster & Per-Persona Settings Dials Suite (Release v1.4.0)', () => {
  let app: any;
  let validApiKey: string;

  beforeEach(() => {
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    app = createApp();
    const createdKey = dashboardStore.createApiKey('test-persona-roster-key');
    validApiKey = createdKey.rawKey;
  });

  it('creates 4 domain-specialized personas in default configuration', () => {
    const config = createDefaultV3Config();
    expect(config.personas.length).toBeGreaterThanOrEqual(4);

    const personaIds = config.personas.map((p) => p.id);
    expect(personaIds).toContain('sec-lane');
    expect(personaIds).toContain('arch-lane');
    expect(personaIds).toContain('qual-lane');
    expect(personaIds).toContain('devops-lane');

    // Path glob scoping checks
    

    const devopsLane = config.personas.find((p) => p.id === 'devops-lane');
    expect(devopsLane?.paths).toEqual(['Dockerfile*', 'k8s/**', '.github/**', 'helm/**', '**/*.yaml']);

    });

  it('validates 4-persona configuration against Zod schema without errors', () => {
    const rawConfig = createDefaultV3Config();
    const result = ctReviewConfigV3Schema.safeParse(rawConfig);
    expect(result.success).toBe(true);
  });

  it('initializes DashboardStore with default settings for all 11 domain personas', () => {
    const store = new DashboardStore('/tmp/test_dashboard_persona_10.json');
    const settings = store.getSettings();

    expect(settings.personaSettings).toBeDefined();
    const keys = Object.keys(settings.personaSettings!);
    expect(keys).toHaveLength(12);
    expect(keys).toContain('security');
    expect(keys).toContain('architecture');
    expect(keys).toContain('performance');
    expect(keys).toContain('quality');
    expect(keys).toContain('database');
    expect(keys).toContain('api_contract');
    expect(keys).toContain('reliability');
    expect(keys).toContain('devops');
    expect(keys).toContain('docs_compliance');
    expect(keys).toContain('finops');
    expect(keys).toContain('red_team');

    expect(settings.personaSettings!.security.effort).toBe('low');
    expect(['claude-5-sonnet', 'claude-3-5-sonnet', 'openrouter/auto']).toContain(settings.personaSettings!.security.model);
    expect(['gpt-5.6-sol', 'gpt-4o', 'glm-5.2', 'openrouter/auto']).toContain(settings.personaSettings!.performance.model);
    expect(['deepseek-v4-pro', 'deepseek-v3', 'openrouter/auto']).toContain(settings.personaSettings!.reliability.model);
    expect(['glm-5.2', 'glm-4', 'deepseek-v3', 'openrouter/auto']).toContain(settings.personaSettings!.devops.model);
  });

  it('validates persona settings payload boundaries in DashboardStore', () => {
    const store = new DashboardStore('/tmp/test_dashboard_validation.json');

    // Invalid confidence threshold > 100
    expect(() =>
      store.validatePersonaSetting({
        id: 'security',
        confidenceThreshold: 150,
        effort: 'high',
        model: 'claude-3-5-sonnet',
        enabled: true,
      })
    ).toThrow(/confidenceThreshold/);

    // Invalid effort level
    expect(() =>
      store.validatePersonaSetting({
        id: 'security',
        confidenceThreshold: 80,
        effort: 'ultra',
        model: 'claude-3-5-sonnet',
        enabled: true,
      })
    ).toThrow(/effort/);

    // Invalid empty model
    expect(() =>
      store.validatePersonaSetting({
        id: 'security',
        confidenceThreshold: 80,
        effort: 'high',
        model: '  ',
        enabled: true,
      })
    ).toThrow(/model/);
  });

  it('atomic PATCH /api/dashboard/settings/personas/:personaId updates single persona', async () => {
    const res = await request(app)
      .patch('/api/dashboard/settings/personas/security')
      .set('x-api-key', validApiKey)
      .send({
        enabled: true,
        model: 'claude-3-5-sonnet',
        effort: 'high',
        confidenceThreshold: 90,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.persona.id).toBe('security');
    expect(res.body.persona.confidenceThreshold).toBe(90);
    expect(res.body.persona.effort).toBe('high');
  });

  it('rejects invalid payload on PUT /api/dashboard/settings with 400 Bad Request', async () => {
    const res = await request(app)
      .put('/api/dashboard/settings')
      .set('x-api-key', validApiKey)
      .send({
        personaSettings: {
          security: {
            confidenceThreshold: 200, // Invalid out of bound
            effort: 'max',
            model: 'claude-3-5-sonnet',
            enabled: true,
          },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('confidenceThreshold');
  });
});
