import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';

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
        // Same two models, unnamespaced, as opencode serves them. Not a widening of what may
        // review code -- a second spelling of the identical pair for the second pinned host.
        'glm-5.3-flash',
        'deepseek-v4-flash-0731',
      ],
      data_collection: 'deny',
      cost_quality_tradeoff: 7,
    });
    expect(resolved.policy_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the direct two-model fleet as the default execution policy', () => {
    const resolved = resolveOpenRouterReviewPolicy({});
    expect(resolved.model).toBe('z-ai/glm-5.3-flash');
    // Two models, each reachable on either pinned destination. The bare ids are the SAME two
    // models as served by opencode, which uses unnamespaced ids -- not four different models, and
    // not a widening of what may review code.
    expect(resolved.allowed_models).toEqual([
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4-flash-0731',
      'glm-5.3-flash',
      'deepseek-v4-flash-0731',
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
      // The auto-router conversion sets this pair explicitly in code, so it stays two entries --
      // it is not reading the manifest and must not drift toward it.
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

  // The base-url check is an exfiltration control: the pipeline ships private diffs to a
  // third-party model, so the destination is pinned. It is now a closed list of two funded
  // transports -- deliberately still a list, never an "any https URL" check.
  describe('review destination allowlist', () => {
    const base = (base_url: string, model: string) => ({
      base_url, model, allowed_models: [model], data_collection: 'deny', cost_quality_tradeoff: 7,
    });

    it('admits both pinned destinations', () => {
      expect(() => validateOpenRouterReviewPolicy(base('https://openrouter.ai/api/v1', 'z-ai/glm-5.3-flash'))).not.toThrow();
      expect(() => validateOpenRouterReviewPolicy(base('https://opencode.ai/zen/v1', 'glm-5.3-flash'))).not.toThrow();
    });

    it('still rejects any destination outside the list', () => {
      for (const url of [
        'https://evil.example/v1',
        'https://openrouter.ai.evil.example/api/v1',
        'https://opencode.ai/zen/v2',
        'http://openrouter.ai/api/v1',
      ]) {
        expect(() => validateOpenRouterReviewPolicy(base(url, 'glm-5.3-flash')), url).toThrow(/base url must normalize exactly/);
      }
    });

    it('still rejects a model outside the canonical set, on either destination', () => {
      expect(() => validateOpenRouterReviewPolicy(base('https://opencode.ai/zen/v1', 'claude-opus-4-8')))
        .toThrow(/canonical approved model/);
    });

    it('still forces data_collection deny', () => {
      const policy = { ...base('https://opencode.ai/zen/v1', 'glm-5.3-flash'), data_collection: 'allow' };
      expect(() => validateOpenRouterReviewPolicy(policy)).toThrow();
    });
  });

  // --- review destination allowlist ----------------------------------------------------------

  describe('review destination allowlist', () => {
    const {
      ALLOWED_REVIEW_BASE_URLS,
      ALLOWED_REVIEW_BASE_URL_DIGESTS,
      createReviewBaseUrlAllowlist,
      isAllowedReviewBaseUrl,
    } = policyModule;

    it('admits each plaintext destination exactly', () => {
      for (const url of ALLOWED_REVIEW_BASE_URLS) {
        expect(isAllowedReviewBaseUrl(url)).toBe(true);
      }
    });

    // This is an exfiltration control, not configuration: private diffs go to the destination.
    it('rejects destinations outside the allowlist', () => {
      for (const url of [
        'https://evil.example/v1',
        'https://openrouter.ai.evil.example/api/v1',
        'https://openrouter.ai/api/v2',
        'http://openrouter.ai/api/v1',
        '',
      ]) {
        expect(isAllowedReviewBaseUrl(url)).toBe(false);
      }
      expect(isAllowedReviewBaseUrl(undefined as any)).toBe(false);
      expect(isAllowedReviewBaseUrl(null as any)).toBe(false);
    });

    // Exercised through the factory rather than the production pin: asserting the real digest
    // branch directly would mean hardcoding the hostname this repository must not carry.
    it('admits a destination matching a pinned digest, and only that one', () => {
      const pinned = 'https://gateway.test.invalid/v1';
      const digest = createHash('sha256').update(pinned).digest('hex');
      const isAllowed = createReviewBaseUrlAllowlist([], [digest]);
      expect(isAllowed(pinned)).toBe(true);
      expect(isAllowed('https://gateway.test.invalid/v2')).toBe(false);
      expect(isAllowed('https://gateway.test.invalid')).toBe(false);
      expect(isAllowed(digest)).toBe(false);
    });

    // A pin that silently emptied would reopen the destination to the plaintext list only, which
    // is a quiet outage rather than a loud one.
    it('carries exactly one well-formed production pin', () => {
      expect(ALLOWED_REVIEW_BASE_URL_DIGESTS).toHaveLength(1);
      for (const digest of ALLOWED_REVIEW_BASE_URL_DIGESTS) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    // Checking the constant is not enough: the predicate is constructed at a separate call site,
    // and emptying the digest list THERE leaves the constant intact. That mutation passed this
    // entire file before this assertion existed, silently un-admitting the destination.
    it('wires the production pins into the production predicate', () => {
      expect(isAllowedReviewBaseUrl.pinnedDigestCount).toBe(ALLOWED_REVIEW_BASE_URL_DIGESTS.length);
      expect(isAllowedReviewBaseUrl.plaintextCount).toBe(ALLOWED_REVIEW_BASE_URLS.length);
    });

    // The whole reason the third destination is digest-pinned is that this repository is public.
    // A later edit pasting the URL in "for readability" would undo that silently.
    //
    // Asserted structurally rather than by naming the forbidden host: spelling it out here would
    // publish in the test the exact string the test exists to keep out of the source.
    it('keeps every URL literal in the policy source within the public allowlist', () => {
      const source = fs.readFileSync(policyModulePath, 'utf8');
      const literals = [...new Set(source.match(/https:\/\/[^'"`\s)]+/g) ?? [])];
      expect(literals.length).toBeGreaterThan(0);
      for (const literal of literals) {
        expect(ALLOWED_REVIEW_BASE_URLS).toContain(literal);
      }
    });
  });
});