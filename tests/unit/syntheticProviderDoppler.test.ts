import { ConfigResolver } from '../../src/config/configResolver';
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

  // synthetic is no longer an ENABLED default: review lanes are flash/light only and default to
  // opencode + claude. The entry is deliberately retained and disabled rather than deleted, so a
  // config that still names it fails validation with "persona references disabled provider
  // synthetic" instead of resolving to nothing. That distinction is the point of this test now.
  it('retains synthetic as a defined but disabled provider, not a default', () => {
    const config = createDefaultV3Config();
    const syntheticProvider = config.reviewers.providers.find((p) => p.id === 'synthetic');

    expect(syntheticProvider).toBeDefined();
    expect(syntheticProvider?.enabled).toBe(false);
    expect(syntheticProvider?.model).toBe('glm-5.3-flash');
    expect(config.reviewers.arbiter.order[0]).toBe('opencode');
    expect(config.reviewers.providers.find((p) => p.id === 'opencode')?.enabled).toBe(true);
  });

  it('validates synthetic provider configuration against Zod schema', () => {
    const rawConfig = createDefaultV3Config();
    const result = ctReviewConfigV3Schema.safeParse(rawConfig);
    expect(result.success).toBe(true);
  });

  // The reason synthetic is DISABLED rather than deleted. A deleted provider leaves a persona
  // that names it referencing nothing; a disabled one is caught by the resolver's own guard and
  // reported with the provider name. That difference is what makes a stale repo config legible
  // instead of mysterious, and it is the whole basis for the choice -- so it gets asserted.
  it('rejects a persona that still names synthetic, naming the provider in the error', () => {
    const config: any = createDefaultV3Config();
    config.personas = [
      { ...config.personas[0], id: 'sec-lane', providers: ['synthetic'] },
    ];
    const resolver = new ConfigResolver();
    expect(() => resolver.validateResolvedConfig(config)).toThrow(/disabled provider synthetic/);
  });
});
