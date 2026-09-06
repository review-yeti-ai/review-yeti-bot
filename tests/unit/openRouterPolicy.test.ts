import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/openrouter-policy.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');

const policyModulePath = path.join(rootRepoDir, '.github/workflows/pipelines/openrouter-policy.js');
const manifestPath = path.join(rootRepoDir, 'src/config/openrouter-review-policy.json');
const policyModule = require(policyModulePath);

const {
  DEFAULT_OPENROUTER_REVIEW_POLICY,
  resolveOpenRouterReviewPolicy,
  validateOpenRouterReviewPolicy,
  buildOpenRouterRequestOptions,
} = policyModule;

describe('openrouter review policy', () => {
  it('loads the checked-in default manifest and resolves to stable defaults', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const resolved = resolveOpenRouterReviewPolicy({});

    expect(DEFAULT_OPENROUTER_REVIEW_POLICY).toEqual(manifest);
    expect(resolved).toMatchObject({
      base_url: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      allowed_models: [
        'z-ai/glm-5.3-flash',
        'deepseek/deepseek-v4-flash-0731',
      ],
      data_collection: 'deny',
      cost_quality_tradeoff: 7,
    });
    expect(resolved.policy_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the direct two-model fleet as the default execution policy', () => {
    const resolved = resolveOpenRouterReviewPolicy({});
    expect(resolved.model).toBe('z-ai/glm-5.3-flash');
    expect(resolved.allowed_models).toEqual([
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4-flash-0731',
    ]);
    expect(resolved.allowed_models).not.toContain('openrouter/auto');
    expect(resolved.allowed_models).not.toContain('openrouter/openai/gpt-4o');
  });

  it('accepts a trusted subset override from the base-commit github_action.openrouter block', () => {
    const resolved = resolveOpenRouterReviewPolicy({
      trustedConfig: {
        github_action: {
          openrouter: {
            model: 'tencent/hy3',
            allowed_models: [
              'tencent/hy3',
              'google/gemini-3.5-flash-lite',
            ],
            cost_quality_tradeoff: 3,
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      model: 'tencent/hy3',
      allowed_models: [
        'tencent/hy3',
        'google/gemini-3.5-flash-lite',
      ],
      cost_quality_tradeoff: 3,
    });
  });

  it('gives trusted action inputs precedence over trusted base-config values', () => {
    const resolved = resolveOpenRouterReviewPolicy({
      actionInputs: {
        model: 'google/gemini-3.5-flash-lite',
        'llm-base-url': 'https://openrouter.ai/api/v1/',
        'allowed-models': 'google/gemini-3.5-flash-lite',
      },
      trustedConfig: {
        github_action: {
          openrouter: {
            model: 'tencent/hy3',
          },
        },
      },
    });

    expect(resolved.model).toBe('google/gemini-3.5-flash-lite');
    expect(resolved.base_url).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects non-OpenRouter base URLs', () => {
    expect(() => resolveOpenRouterReviewPolicy({
      actionInputs: { 'llm-base-url': 'https://openrouter.example/v1' },
    })).toThrow(/base url/i);
  });

  it('rejects execution models outside the alias or canonical allowlist', () => {
    expect(() => resolveOpenRouterReviewPolicy({
      actionInputs: { model: 'openrouter/openai/gpt-4o' },
    })).toThrow(/model/i);
  });

  it('rejects allowed_models values that contain aliases, provider names, URLs, or arbitrary models', () => {
    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      allowed_models: ['openrouter/auto'],
    })).toThrow(/allowed_models/i);

    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      allowed_models: ['openrouter'],
    })).toThrow(/allowed_models/i);

    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      allowed_models: ['https://openrouter.ai/api/v1'],
    })).toThrow(/allowed_models/i);

    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      allowed_models: ['openrouter/openai/gpt-4o'],
    })).toThrow(/allowed_models/i);
  });

  it('rejects provider data collection values other than deny', () => {
    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      data_collection: 'allow',
    })).toThrow(/data_collection/i);
  });

  it('rejects unknown keys instead of ignoring them', () => {
    expect(() => validateOpenRouterReviewPolicy({
      ...DEFAULT_OPENROUTER_REVIEW_POLICY,
      extra: true,
    })).toThrow(/unknown/i);
  });

  it('produces a stable fingerprint and repeated resolution equality for identical inputs', () => {
    const first = resolveOpenRouterReviewPolicy({
      trustedConfig: {
        github_action: {
          openrouter: {
            allowed_models: [
              'google/gemini-3.5-flash-lite',
              'tencent/hy3',
            ],
            model: 'google/gemini-3.5-flash-lite',
          },
        },
      },
    });
    const second = resolveOpenRouterReviewPolicy({
      trustedConfig: {
        github_action: {
          openrouter: {
            allowed_models: [
              'google/gemini-3.5-flash-lite',
              'tencent/hy3',
            ],
            model: 'google/gemini-3.5-flash-lite',
          },
        },
      },
    });

    expect(second).toEqual(first);
    expect(second.policy_fingerprint).toBe(first.policy_fingerprint);
  });

  it('converts a legacy auto-router override into the direct two-model request policy', () => {
    const resolved = resolveOpenRouterReviewPolicy({
      trustedConfig: {
        github_action: {
          openrouter: {
            allowed_models: [
              'tencent/hy3',
              'google/gemini-3.5-flash-lite',
            ],
            model: 'openrouter/auto',
            cost_quality_tradeoff: 4,
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      model: 'z-ai/glm-5.3-flash',
      allowed_models: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash-0731'],
    });
    expect(buildOpenRouterRequestOptions(resolved)).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'z-ai/glm-5.3-flash',
      policyFingerprint: resolved.policy_fingerprint,
      provider: {
        data_collection: 'deny',
      },
    });
  });
});
