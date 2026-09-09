import { describe, expect, it } from 'vitest';
import { resolveWorkerConfig as resolveFromCli } from '../../src/cli/publishingReview';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';

const transport = { baseUrl: 'https://bifrost.example.test', apiKey: 'synthetic-test-key', model: 'review-model' };

describe('publishing worker config extraction', () => {
  it('keeps the CLI export as the same dependency-light resolver', () => {
    expect(resolveFromCli).toBe(resolveWorkerConfig);
  });

  it('preserves the Bifrost provider and current turn clamp', () => {
    const config = resolveWorkerConfig({ NODE_ENV: 'test', REVIEW_PERSONAS: 'security, architecture', MAX_INVESTIGATION_TURNS: '99' }, transport);

    expect(config.default_max_turns).toBe(3);
    expect(config.personas.map((persona) => persona.id)).toEqual(['sec-lane', 'arch-lane']);
    expect(config.personas.every((persona) => persona.providers?.length === 1 && persona.providers[0] === 'bifrost')).toBe(true);
    expect(config.reviewers.providers).toMatchObject([{ id: 'bifrost', model: 'review-model' }]);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
  });
});
