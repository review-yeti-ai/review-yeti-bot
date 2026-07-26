import { describe, it, expect } from 'vitest';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { DashboardStore } from '../../src/persistence/dashboardStore';

describe('10-Persona Roster & Per-Persona Settings Dials Suite (Release v1.4.0)', () => {
  it('creates 10 domain-specialized personas in default configuration', () => {
    const config = createDefaultV3Config();
    expect(config.personas).toHaveLength(10);

    const personaIds = config.personas.map((p) => p.id);
    expect(personaIds).toEqual([
      'sec-lane',
      'arch-lane',
      'perf-lane',
      'qual-lane',
      'db-lane',
      'api-lane',
      'sre-lane',
      'devops-lane',
      'docs-lane',
      'finops-lane',
    ]);
  });

  it('validates 10-persona configuration against Zod schema without errors', () => {
    const rawConfig = createDefaultV3Config();
    const result = ctReviewConfigV3Schema.safeParse(rawConfig);
    expect(result.success).toBe(true);
  });

  it('initializes DashboardStore with default settings for all 10 domain personas', () => {
    const store = new DashboardStore('/tmp/test_dashboard_persona_10.json');
    const settings = store.getSettings();

    expect(settings.personaSettings).toBeDefined();
    const keys = Object.keys(settings.personaSettings!);
    expect(keys).toHaveLength(10);
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

    expect(settings.personaSettings!.security.effort).toBe('max');
    expect(settings.personaSettings!.performance.model).toBe('gpt-5.6-sol');
  });
});
