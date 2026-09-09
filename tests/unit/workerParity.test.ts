import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkerConfig } from '../../src/cli/publishingReview';

describe('GHA and DOKS Worker Configuration Policy Parity', () => {
  const policyPath = path.resolve(__dirname, '../../../../ct-review-actions/policy/review-yeti.json');
  const policyRaw = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, 'utf8') : null;

  const transport = {
    baseUrl: 'https://gateway.example.invalid/v1',
    apiKey: 'vk-test-parity',
    model: 'ollama/glm-5.3-flash',
  };

  it('resolves identical 6-persona roster from policy/review-yeti.json and worker default', () => {
    // 1. Worker default with no env overrides
    const defaultConfig = resolveWorkerConfig({ NODE_ENV: 'test' }, transport);
    const expectedPersonas = [
      'sec-lane',
      'perf-lane',
      'arch-lane',
      'qual-lane',
      'dep-lane',
      'policy-lane',
    ];
    expect(defaultConfig.personas.map((p) => p.id)).toEqual(expectedPersonas);

    // 2. Worker configured with central policy file
    if (policyRaw) {
      const policyConfig = resolveWorkerConfig(
        { NODE_ENV: 'test', REVIEW_YETI_POLICY_JSON: policyRaw },
        transport,
      );
      expect(policyConfig.personas.map((p) => p.id)).toEqual(expectedPersonas);
      expect(policyConfig.default_max_turns).toBe(2);
    }
  });

  it('enforces Bifrost-only transport provider across all personas and arbiter', () => {
    const config = resolveWorkerConfig({ NODE_ENV: 'test' }, transport);
    for (const persona of config.personas) {
      expect(persona.providers).toEqual(['bifrost']);
    }
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
    expect(config.reviewers.providers).toHaveLength(1);
    expect(config.reviewers.providers[0].id).toBe('bifrost');
    expect(config.reviewers.providers[0].model).toBe('ollama/glm-5.3-flash');
  });

  it('strictly caps max investigation turns at 3', () => {
    const highTurnPolicy = JSON.stringify({
      review_yeti: {
        personas: 'security,performance',
        budget: { max_investigation_turns: '20' },
      },
    });
    const config = resolveWorkerConfig(
      { NODE_ENV: 'test', REVIEW_YETI_POLICY_JSON: highTurnPolicy },
      transport,
    );
    expect(config.default_max_turns).toBe(3);
  });
});
