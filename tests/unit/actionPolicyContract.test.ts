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
    expect(result.files[0].isSubmodule).not.toBe(true);
  });

  it('does not treat a normal text file containing a subproject marker as a gitlink', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'docs/submodules.md', patch: 'diff --git a/docs/submodules.md b/docs/submodules.md\n+Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' },
    ], { mode: 'metadata_only', require_pinned_commit: true });
    expect(result.coverageComplete).toBe(false);
    expect(result.files[0].isSubmodule).not.toBe(true);
  });

  it('parses standard hunked gitlink patches when native mode metadata is present', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      {
        path: 'vendor/lib',
        mode: '160000',
        patch: 'diff --git a/vendor/lib b/vendor/lib\nold mode 160000\nnew mode 160000\n@@ -1,3 +1,3 @@\n context\n-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n context',
      },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files[0]).toMatchObject({ oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), isSubmodule: true });
  });

  it('fails closed when configured submodule origin allowlists cannot be checked', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] });
    expect(result.coverageComplete).toBe(false);
  });

  it('accepts a native gitlink when trusted checkout metadata supplies its origin', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] }, {
      baseSubmoduleUrls: { 'vendor/lib': 'https://github.com/review-yeti-ai/review-yeti-bot.git' },
      submoduleUrls: { 'vendor/lib': 'https://github.com/review-yeti-ai/review-yeti-bot.git' },
    });
    expect(result.coverageComplete).toBe(true);
  });

  it('parses HTTPS submodule origins with credentials and ports as URLs', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), newSubmoduleUrl: 'https://token@github.com:443/review-yeti-ai/review-yeti-bot.git' },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: ['review-yeti-ai/review-yeti-bot'] });
    expect(result.coverageComplete).toBe(true);
  });

  it('compares base and head submodule URLs and allows metadata-only origin review', () => {
    const stable = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] }, {
      baseSubmoduleUrls: { 'vendor/lib': 'https://github.com/review-yeti-ai/review-yeti-bot.git' },
      submoduleUrls: { 'vendor/lib': 'https://github.com/review-yeti-ai/review-yeti-bot.git' },
    });
    expect(stable.coverageComplete).toBe(true);

    const reviewOnly = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true, missing_access: 'metadata_only', allowed_hosts: ['github.com'], allowed_repositories: [] });
    expect(reviewOnly.coverageComplete).toBe(true);
  });

  it('keeps URL changes reviewable when policy requests metadata review', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), oldSubmoduleUrl: 'https://github.com/review-yeti-ai/old.git', newSubmoduleUrl: 'https://github.com/review-yeti-ai/new.git' },
    ], { mode: 'metadata_only', require_pinned_commit: true, url_change: 'review' });
    expect(result.coverageComplete).toBe(true);
  });

  it('detects native gitlink mode metadata when the patch is absent', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      {
        path: 'vendor/lib',
        status: 'modified',
        mode: '160000',
        oldSha: 'a'.repeat(40),
        newSha: 'b'.repeat(40),
      },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files[0]).toMatchObject({ isSubmodule: true, mode: '160000' });
  });

  it('accepts native gitlink additions and deletions with only their existing-side SHA', () => {
    const result = pipeline.applyActionSubmodulePolicy([
      { path: 'vendor/added', status: 'added', mode: '160000', newSha: 'a'.repeat(40) },
      { path: 'vendor/deleted', status: 'deleted', mode: '160000', oldSha: 'b'.repeat(40) },
    ], { mode: 'metadata_only', require_pinned_commit: true });

    expect(result.coverageComplete).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((file: any) => file.isSubmodule)).toBe(true);
  });

  it('exports the canonical arbitration helper used by the Action entrypoint', () => {
    expect(pipeline.computeArbitrationQuorum).toBeTypeOf('function');
    expect(pipeline.computeArbitrationQuorum([{ findings: [] }], 1).verdict).toBe('SHIP');
  });

  it('does not turn incomplete trusted submodule coverage into policy-only SHIP', () => {
    const arbitration = pipeline.buildCoverageTerminalArbitration({
      reviewed: [],
      skipped: [],
      oversized: [{ path: 'vendor/spec.json', category: 'oversized', reason: 'per-file cap', diffChars: 5_001 }],
      truncated: [],
      omitted: [],
      passes: 0,
    }, { submoduleCoverageComplete: false });

    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.status).toBe('INCOMPLETE_REVIEW');
    expect(arbitration.coverageComplete).toBe(false);
    expect(arbitration.rationale).toMatch(/submodule|coverage/i);
  });

  it('marks policy-only terminal coverage as a clean, merge-eligible result', () => {
    const arbitration = pipeline.buildCoverageTerminalArbitration({
      reviewed: [],
      skipped: [{ path: 'package-lock.json', category: 'generated', reason: 'lockfile policy' }],
      oversized: [],
      truncated: [],
      omitted: [],
      passes: 0,
    });

    expect(arbitration).toMatchObject({
      verdict: 'SHIP',
      status: 'SHIP',
      coverageStatus: 'complete',
      gateDecision: 'PASS',
      mergeEligible: true,
    });
  });
});
