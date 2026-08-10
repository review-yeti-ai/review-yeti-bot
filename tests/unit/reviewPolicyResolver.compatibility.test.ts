import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/review/reviewPolicyResolver.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const { resolveTrustedReviewPolicy } = require(path.join(root, 'src/review/reviewPolicyResolver.js'));
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const os = require('node:os');

describe('trusted review policy resolver compatibility', () => {
  it('does not enter the exact-SHA v1 resolver for a legacy configuration', () => {
    expect(pipeline.shouldResolveTrustedReviewPolicy({ parsed: { version: 4, memory: { honcho: { enabled: true } } } })).toBe(false);
    expect(pipeline.shouldResolveTrustedReviewPolicy({ parsed: { review_intelligence: { version: 1, enabled: true } } })).toBe(true);
  });

  it('leaves the versioned policy disabled and inert when legacy configuration has no review_intelligence block', () => {
    const policy = resolveTrustedReviewPolicy({
      trustedConfig: { raw: 'version: 4\nmemory:\n  honcho:\n    enabled: true\n', parsed: { version: 4, memory: { honcho: { enabled: true } } } },
      baseRef: 'a'.repeat(40),
      headRef: 'b'.repeat(40),
    });

    expect(policy).toMatchObject({ schemaVersion: 'trusted-review-policy-v1', enabled: false, status: 'disabled', limits: {} });
    expect(policy).not.toHaveProperty('capabilities');
  });

  it('carries a trusted YAML parse failure to the v1 resolver without enabling the legacy contract', () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-malformed-'));
    fs.writeFileSync(path.join(configRoot, '.review-yeti.yaml'), 'review_intelligence: [');

    const config = pipeline.loadLocalRepoConfig(configRoot);
    const policy = resolveTrustedReviewPolicy({
      trustedConfig: config,
      baseRef: 'a'.repeat(40),
      headRef: 'b'.repeat(40),
    });

    expect(config).toMatchObject({ file: '.review-yeti.yaml', raw: 'review_intelligence: [', parseError: expect.any(Error) });
    expect(policy).toMatchObject({ enabled: false, status: 'invalid_config', reason: 'trusted_config_parse_failed' });
  });
});
