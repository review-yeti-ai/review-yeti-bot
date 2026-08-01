import { describe, it, expect } from 'vitest';
import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';

describe('Synthetic API Provider & Doppler Secret Management Suite (Release v1.5.1)', () => {
  it('retrieves SYNTHETIC_API_KEY secret dynamically from Doppler CLI / environment without hardcoding in source', async () => {
    // Populate process.env if needed for fallback environment tier
    if (!process.env.SYNTHETIC_API_KEY) {
      process.env.SYNTHETIC_API_KEY = 'syn_test0000000000000000000000000';
    }

    const doppler = new DopplerSecretManager({ fallbackEnv: true });
    const secret = await doppler.getSecret('SYNTHETIC_API_KEY');

    expect(secret).not.toBeNull();
    expect(secret!).toContain('syn_test0000000000000000000000000');
  });

  it('includes synthetic provider as default provider in V3 configuration', () => {
    const config = createDefaultV3Config();
    const syntheticProvider = config.reviewers.providers.find((p) => p.id === 'synthetic');

    expect(syntheticProvider).toBeDefined();
    expect(syntheticProvider?.enabled).toBe(true);
    expect(syntheticProvider?.model).toBe('glm-5.2');
    expect(config.reviewers.arbiter.order[0]).toBe('synthetic');
  });

  it('validates synthetic provider configuration against Zod schema', () => {
    const rawConfig = createDefaultV3Config();
    const result = ctReviewConfigV3Schema.safeParse(rawConfig);
    expect(result.success).toBe(true);
  });
});
