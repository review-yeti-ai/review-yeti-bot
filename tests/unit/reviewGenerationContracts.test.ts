import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  applyTrustedOverrides,
  createDefaultV4Config,
  normalizeConfigToV4,
  parseAndValidateConfig,
} from '../../src/config/configLoader';
import { createPRSnapshot, assertSnapshotCurrent, snapshotDigest } from '../../src/review/prSnapshot';
import { resolveSubmoduleDecision } from '../../src/review/submodulePolicy';
import { ConfigResolver } from '../../src/config/configResolver';

describe('generational review identity and policy contracts', () => {
  it('creates a stable immutable snapshot bound to exact head and base commits', () => {
    const snapshot = createPRSnapshot({
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      mergeBaseSha: 'c'.repeat(40),
      title: 'Add review contract',
      configRef: 'b'.repeat(40),
      configDigest: 'd'.repeat(64),
      engineVersion: 'review-core-v1',
      changedFiles: [{ path: 'src/review.ts', patch: '@@ -1 +1 @@\n+new' }],
    });

    expect(snapshotDigest(snapshot)).toBe(snapshot.snapshotDigest);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => assertSnapshotCurrent(snapshot, { headSha: snapshot.headSha, baseSha: snapshot.baseSha })).not.toThrow();
    expect(() => assertSnapshotCurrent(snapshot, { headSha: 'e'.repeat(40), baseSha: snapshot.baseSha })).toThrow(/head SHA/i);
    expect(() => assertSnapshotCurrent(snapshot, { headSha: snapshot.headSha, baseSha: 'f'.repeat(40) })).toThrow(/base SHA/i);
  });

  it('normalizes v3 policy to v4 and applies only bounded trusted overrides', () => {
    const v4 = normalizeConfigToV4(createDefaultV4Config());
    const overridden = applyTrustedOverrides(v4, {
      limits: { max_diff_bytes: 999_999_999, max_completion_tokens: 1234 },
      submodules: { mode: 'metadata_only', max_depth: 99 },
    });

    expect(v4.version).toBe(4);
    expect(overridden.version).toBe(4);
    expect(overridden.limits.max_completion_tokens).toBe(1234);
    expect(overridden.limits.max_diff_bytes).toBeLessThan(999_999_999);
    expect(overridden.submodules.mode).toBe('metadata_only');
    expect(overridden.submodules.max_depth).toBeLessThanOrEqual(5);
  });

  it('parses a v4 YAML policy and produces the same digest on repeat', () => {
    const source = yaml.dump({
      ...createDefaultV4Config(),
      submodules: { mode: 'metadata_only', max_depth: 2, max_files: 50, require_pinned_commit: true, missing_access: 'block', allowed_repositories: [], allowed_hosts: ['github.com'], url_change: 'block' },
    });
    const first = parseAndValidateConfig(source) as any;
    const second = parseAndValidateConfig(source) as any;
    expect(first.version).toBe(4);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('retains v4 submodule and limit policy in resolver provenance at the repository ref', async () => {
    const source = yaml.dump({ ...createDefaultV4Config(), submodules: { mode: 'recursive' } });
    const client = {
      getFileContent: async (_owner: string, repo: string, file: string) => repo === 'repo' && file === '.ct-review.yaml' ? source : null,
    };
    const resolved = await new ConfigResolver().resolveConfigWithProvenance({ owner: 'owner', repo: 'repo', ref: 'b'.repeat(40), client });
    expect(resolved.source).toBe('repository');
    expect(resolved.config.version).toBe(4);
    expect(resolved.config.submodules.mode).toBe('recursive');
    expect(resolved.configDigest).toHaveLength(64);
  });

  it('fails closed for unpinned or recursive submodule changes', () => {
    const file = { path: 'vendor/lib', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), isSubmodule: true };
    expect(resolveSubmoduleDecision(file, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'REVIEW_METADATA' });
    expect(resolveSubmoduleDecision({ ...file, newSha: 'not-a-commit' }, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'BLOCK' });
    expect(resolveSubmoduleDecision(file, { mode: 'recursive', require_pinned_commit: true })).toMatchObject({ decision: 'INCOMPLETE_REVIEW' });
    expect(resolveSubmoduleDecision(file, { mode: 'ignore', require_pinned_commit: true })).toMatchObject({ decision: 'IGNORE' });
  });

  it('accepts a pinned gitlink addition or deletion without inventing a missing-side SHA', () => {
    const policy = { mode: 'metadata_only' as const, require_pinned_commit: true };

    expect(resolveSubmoduleDecision({
      path: 'vendor/added',
      mode: '160000',
      newSha: 'a'.repeat(40),
      isSubmodule: true,
    }, policy)).toMatchObject({ decision: 'REVIEW_METADATA' });

    expect(resolveSubmoduleDecision({
      path: 'vendor/deleted',
      mode: '160000',
      oldSha: 'b'.repeat(40),
      isSubmodule: true,
    }, policy)).toMatchObject({ decision: 'REVIEW_METADATA' });
  });

  it.each([
    ['mode', { mode: '160000' }],
    ['oldMode', { oldMode: '160000' }],
    ['newMode', { newMode: '160000' }],
    ['old_mode', { old_mode: '160000' }],
    ['new_mode', { new_mode: '160000' }],
  ])('recognizes the %s gitlink mode alias', (_alias, mode) => {
    const decision = resolveSubmoduleDecision({
      path: 'vendor/aliased-lib',
      ...mode,
      newSha: 'a'.repeat(40),
    }, { mode: 'metadata_only', require_pinned_commit: true });

    expect(decision).toMatchObject({ decision: 'REVIEW_METADATA', reviewable: true });
  });

  it('fails closed when an aliased gitlink mode has no pinned commit', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/unpinned-lib',
      old_mode: '160000',
    }, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'BLOCK', reviewable: false });
  });

  it('blocks a patch-only submodule candidate until native gitlink metadata is available', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/candidate',
      submoduleCandidate: true,
      oldSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
    }, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'BLOCK', reviewable: false });
  });

  it('requires both pinned SHAs for a modified submodule', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/modified',
      status: 'modified',
      mode: '160000',
      newSha: 'a'.repeat(40),
      isSubmodule: true,
    }, { mode: 'metadata_only', require_pinned_commit: true })).toMatchObject({ decision: 'BLOCK' });
  });

  it('blocks an explicitly reported submodule URL change under the block policy', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/url-change',
      mode: '160000',
      oldSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      oldSubmoduleUrl: 'https://github.com/example/old.git',
      newSubmoduleUrl: 'https://example.invalid/new.git',
      isSubmodule: true,
    }, { mode: 'metadata_only', require_pinned_commit: true, url_change: 'block' })).toMatchObject({ decision: 'BLOCK' });
  });

  it('requires metadata review for an explicitly reported submodule URL change', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/url-review',
      mode: '160000',
      oldSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      submoduleUrlChanged: true,
      isSubmodule: true,
    }, { mode: 'recursive', require_pinned_commit: true, url_change: 'review' })).toMatchObject({ decision: 'REVIEW_METADATA', reviewable: true });
  });

  it('enforces submodule host and repository allowlists when origin metadata is available', () => {
    const file = {
      path: 'vendor/allowed',
      mode: '160000',
      oldSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      newSubmoduleUrl: 'https://github.com/calltelemetry/ct-pr-operator.git',
      isSubmodule: true,
    };
    expect(resolveSubmoduleDecision(file, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: ['calltelemetry/ct-pr-operator'], url_change: 'review' })).toMatchObject({ decision: 'REVIEW_METADATA' });
    expect(resolveSubmoduleDecision({ ...file, newSubmoduleUrl: 'https://example.invalid/attacker.git' }, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: [] })).toMatchObject({ decision: 'BLOCK' });
    expect(resolveSubmoduleDecision({ ...file, oldSubmoduleUrl: undefined }, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], url_change: 'block' })).toMatchObject({ decision: 'BLOCK' });
    expect(resolveSubmoduleDecision({ ...file, newSubmoduleUrl: 'https://token@github.com:443/calltelemetry/ct-pr-operator.git' }, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: ['calltelemetry/ct-pr-operator'], url_change: 'review' })).toMatchObject({ decision: 'REVIEW_METADATA' });
    expect(resolveSubmoduleDecision({ ...file, newSubmoduleUrl: 'https://github.com@attacker.invalid/calltelemetry/ct-pr-operator.git' }, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], allowed_repositories: ['calltelemetry/ct-pr-operator'], url_change: 'review' })).toMatchObject({ decision: 'BLOCK' });
  });

  it('resolves relative submodule URLs against the parent repository', () => {
    expect(resolveSubmoduleDecision({
      path: 'vendor/relative',
      mode: '160000',
      oldSha: 'a'.repeat(40),
      newSha: 'b'.repeat(40),
      newSubmoduleUrl: '../dependency.git',
      parentRepository: 'calltelemetry/parent',
      isSubmodule: true,
    }, { mode: 'metadata_only', require_pinned_commit: true, allowed_hosts: ['github.com'], url_change: 'review' })).toMatchObject({ decision: 'REVIEW_METADATA' });
  });
});
