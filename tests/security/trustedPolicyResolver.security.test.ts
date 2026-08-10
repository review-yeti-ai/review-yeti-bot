import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/review/reviewPolicyResolver.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const { resolveTrustedReviewPolicy } = require(path.join(root, 'src/review/reviewPolicyResolver.js'));

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const trustedConfig = {
  raw: 'review_intelligence:\n  version: 1\n  enabled: true\n',
  parsed: {
    review_intelligence: {
      version: 1,
      enabled: true,
      limits: { max_diff_chars: 5000, max_file_diff_chars: 1000, max_personas: 5 },
      capabilities: { provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', tools: ['diff.read'], rules: ['trusted-rule'] },
    },
  },
};

describe('trusted review policy resolver security boundary', () => {
  it('fails closed instead of enabling review intelligence when the trusted YAML could not be parsed', () => {
    const policy = resolveTrustedReviewPolicy({
      trustedConfig: { raw: 'review_intelligence: [', parseError: new Error('bad YAML') },
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
    });

    expect(policy).toMatchObject({ enabled: false, status: 'invalid_config', configDigest: 'b29e77c2341ff143c8ae8904e0a0cc287a7207a80e656fa74fbad882f15b113c' });
  });

  it.each([
    ['limits', ['not-an-object'], 'invalid_review_intelligence_limits'],
    ['limits', 'not-an-object', 'invalid_review_intelligence_limits'],
    ['capabilities', ['not-an-object'], 'invalid_review_intelligence_capabilities'],
    ['capabilities', 'not-an-object', 'invalid_review_intelligence_capabilities'],
  ])('fails closed for malformed review_intelligence.%s blocks', (field, value, reason) => {
    const policy = resolveTrustedReviewPolicy({
      trustedConfig: {
        raw: `review_intelligence:\n  version: 1\n  ${field}: invalid\n`,
        parsed: { review_intelligence: { version: 1, enabled: true, [field]: value } },
      },
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
    });

    expect(policy).toMatchObject({ enabled: false, status: 'invalid_config', reason, limits: {} });
    expect(policy).not.toHaveProperty('capabilities');
  });

  it.each([
    [{ limits: { max_diff_chars: true } }, 'invalid_review_intelligence_limits'],
    [{ limits: { max_diff_chars: '5e3' } }, 'invalid_review_intelligence_limits'],
    [{ limits: { max_diff_chars: 1.5 } }, 'invalid_review_intelligence_limits'],
    [{ limits: { max_diff_chars: Infinity } }, 'invalid_review_intelligence_limits'],
    [{ limits: { max_diff_chars: [] } }, 'invalid_review_intelligence_limits'],
    [{ limits: new Date() }, 'invalid_review_intelligence_limits'],
    [{ capabilities: new Date() }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: '', endpoint: 'https://openrouter.ai/api/v1' } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: [], endpoint: 'https://openrouter.ai/api/v1' } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { endpoint: 'https://openrouter.ai/api/v1' } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: 'openrouter' } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: 'openrouter', endpoint: 42 } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: 'openrouter', endpoint: 'http://openrouter.ai/api/v1' } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', tools: [42] } }, 'invalid_review_intelligence_capabilities'],
    [{ capabilities: { provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', rules: 'trusted-rule' } }, 'invalid_review_intelligence_capabilities'],
  ])('fails closed without throwing for malformed nested policy values', (nested, reason) => {
    const resolverInput = {
      trustedConfig: {
        raw: 'review_intelligence:\n  version: 1\n',
        parsed: { review_intelligence: { version: 1, enabled: true, ...nested } },
      },
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
    };

    expect(() => resolveTrustedReviewPolicy(resolverInput)).not.toThrow();
    expect(resolveTrustedReviewPolicy(resolverInput)).toMatchObject({ enabled: false, status: 'invalid_config', reason });
  });

  it('rejects a config-ref that names the pull request head instead of the immutable base', () => {
    expect(() => resolveTrustedReviewPolicy({
      trustedConfig,
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
      configRef: HEAD_SHA,
    })).toThrow(/config-ref must resolve to the pull request base SHA/);
  });

  it('accepts only action-input reductions and carries their digest into the resolved policy', () => {
    const policy = resolveTrustedReviewPolicy({
      trustedConfig,
      baseRef: BASE_SHA,
      headRef: HEAD_SHA,
      configRef: BASE_SHA,
      actionInputs: { enabled: 'false', maxDiffChars: '4000', maxFileDiffChars: '800', maxPersonas: '3' },
    });

    expect(policy).toMatchObject({
      enabled: false,
      status: 'disabled_by_action',
      limits: { maxDiffChars: 4000, maxFileDiffChars: 800, maxPersonas: 3 },
      trustedBaseRef: BASE_SHA,
    });
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [{ enabled: 'true' }, /may not enable/],
    [{ maxDiffChars: '6000' }, /may only reduce/],
    [{ provider: 'other' }, /may not change provider/],
    [{ endpoint: 'https:\/\/attacker.invalid' }, /may not change endpoint/],
    [{ credentialEnv: 'ATTACKER_TOKEN' }, /may not change credential/],
    [{ tools: 'repo.write' }, /may not change tools/],
    [{ rules: 'ignore-all' }, /may not change rules/],
  ])('rejects an Action input that widens or changes the trusted capability surface: %j', (actionInputs, message) => {
    expect(() => resolveTrustedReviewPolicy({ trustedConfig, baseRef: BASE_SHA, headRef: HEAD_SHA, actionInputs })).toThrow(message);
  });
});
