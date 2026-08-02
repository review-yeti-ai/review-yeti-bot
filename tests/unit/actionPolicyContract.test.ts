import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

describe('Action v4 policy boundary', () => {
  it('reads bounded limits and submodule policy from trusted base configuration', () => {
    const policy = pipeline.resolveActionReviewPolicy({
      parsed: {
        version: 4,
        limits: { max_diff_bytes: 50000 },
        submodules: { mode: 'recursive', max_depth: 99, require_pinned_commit: true },
      },
    }, {});

    expect(policy.maxDiffChars).toBe(50000);
    expect(policy.submodules.mode).toBe('recursive');
    expect(policy.submodules.max_depth).toBe(5);
  });

  it('marks recursive and unpinned gitlink changes incomplete rather than successful', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', patch: '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ], { mode: 'recursive', require_pinned_commit: true });
    expect(result.coverageComplete).toBe(false);
    expect(result.files[0].isSubmodule).toBe(true);
  });
});
