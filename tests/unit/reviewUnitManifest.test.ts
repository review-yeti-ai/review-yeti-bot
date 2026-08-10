import { describe, expect, it } from 'vitest';
import {
  classifyReviewUnitFile,
  createReviewUnitManifest,
  stableReviewUnitId,
} from '../../src/review/reviewUnitManifest';

const identity = {
  repository: 'owner/repository',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  configDigest: 'c'.repeat(64),
  policyDigest: 'd'.repeat(64),
  diffDigest: 'e'.repeat(64),
};

const policy = {
  maxFileDiffChars: 120,
  generatedPatterns: ['generated/**'],
  vendorPatterns: ['vendor/**'],
};

describe('review-unit manifest', () => {
  it('keeps the same unit ID across reruns without hashing model prose', () => {
    const input = { path: 'src/app.js', range: { start: 2, end: 4 }, content: '+const safe = true', blobSha: 'f'.repeat(40), policyDigest: identity.policyDigest };
    const first = stableReviewUnitId(input);
    const second = stableReviewUnitId({ ...input, modelSummary: 'This looks safe.', rationale: 'completely different reviewer prose' });

    expect(first).toBe(second);
    expect(first).toMatch(/^ru_[a-f0-9]{64}$/);
  });

  it('changes the unit ID when policy-controlled review identity changes', () => {
    const input = { path: 'src/app.js', range: { start: 1, end: 1 }, content: '+x', blobSha: 'f'.repeat(40), policyDigest: identity.policyDigest };
    expect(stableReviewUnitId(input)).not.toBe(stableReviewUnitId({ ...input, policyDigest: '0'.repeat(64) }));
  });

  it('classifies every special diff boundary explicitly', () => {
    expect(classifyReviewUnitFile({ path: 'generated/schema.generated.json', patch: '+{}' }, policy)).toMatchObject({ status: 'excluded', reason: 'generated' });
    expect(classifyReviewUnitFile({ path: 'vendor/lib.js', patch: '+x' }, { ...policy, vendorPatterns: ['vendor/**'] })).toMatchObject({ status: 'excluded', reason: 'vendored' });
    expect(classifyReviewUnitFile({ path: 'assets/logo.png', patch: 'Binary files a/assets/logo.png and b/assets/logo.png differ' }, policy)).toMatchObject({ status: 'excluded', reason: 'binary' });
    expect(classifyReviewUnitFile({ path: 'src/large.js', patch: '+'.repeat(121) }, policy)).toMatchObject({ status: 'oversized' });
    expect(classifyReviewUnitFile({ path: 'src/old.js', previousPath: 'src/new.js', status: 'renamed', patch: '' }, policy)).toMatchObject({ status: 'unreviewable', reason: 'rename_only' });
    expect(classifyReviewUnitFile({ path: 'src/deleted.js', status: 'removed', patch: '-old' }, policy)).toMatchObject({ status: 'selected', change: 'deleted' });
    expect(classifyReviewUnitFile({ path: 'modules/core', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) }, policy)).toMatchObject({ status: 'selected', change: 'gitlink' });
    expect(classifyReviewUnitFile({ path: 'modules/core', mode: '160000', newSha: 'main' }, policy)).toMatchObject({ status: 'unreviewable', reason: 'unpinned_submodule' });
    expect(classifyReviewUnitFile({ path: 'modules/core', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), submoduleUrlChanged: true }, policy)).toMatchObject({ status: 'unreviewable', reason: 'submodule_url_changed' });
  });

  it('uses the shared ignore policy including negated trusted restoration rules', () => {
    expect(classifyReviewUnitFile({ path: 'src/generated/schema.ts', patch: '+generated' }, {
      ...policy,
      exclude: ['src/generated/**', '!src/generated/**'],
    })).toMatchObject({ status: 'selected' });
    expect(classifyReviewUnitFile({ path: 'nested/generated/schema.ts', patch: '+generated' }, {
      ...policy,
      exclude: ['generated/**'],
    })).toMatchObject({ status: 'selected' });
  });

  it('retains ignored trusted submodules as explicit excluded units', () => {
    expect(classifyReviewUnitFile({ path: 'modules/core', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), submoduleIgnored: true }, policy)).toMatchObject({
      status: 'excluded', reason: 'submodule_ignored', change: 'gitlink',
    });
  });

  it('fails closed for an untrusted waiver', () => {
    expect(classifyReviewUnitFile({ path: 'src/app.js', patch: '+x', unitStatus: 'waived' }, policy)).toMatchObject({ status: 'failed', reason: 'waiver_not_trusted' });
    expect(classifyReviewUnitFile({ path: 'src/app.js', patch: '+x', unitStatus: 'waived' }, { ...policy, allowWaived: true })).toMatchObject({ status: 'waived' });
  });

  it('does not let non-rule policy input override a trusted waiver boundary', () => {
    const manifest = createReviewUnitManifest({
      identity,
      trustedRules: { ...policy, allowWaived: false },
      policy: { allowWaived: true },
      files: [{ path: 'src/app.js', patch: '+x', unitStatus: 'waived' }],
    });
    expect(manifest.units[0]).toMatchObject({ status: 'failed', reason: 'waiver_not_trusted' });
    expect(manifest.coverage.shipEligible).toBe(false);
  });

  it('keeps head identity exact while retaining a path/content-stable unit ID', () => {
    const files = [{ path: 'src/app.js', patch: '+const app = 1', blobSha: 'f'.repeat(40), unitStatus: 'completed' }];
    const first = createReviewUnitManifest({ identity, files, trustedRules: policy, policy, now: () => 100 });
    const second = createReviewUnitManifest({ identity: { ...identity, headSha: '9'.repeat(40), diffDigest: '8'.repeat(64) }, files, trustedRules: policy, policy, now: () => 200 });

    expect(first.identity.headSha).toBe(identity.headSha);
    expect(second.identity.headSha).toBe('9'.repeat(40));
    expect(first.units[0].id).toBe(second.units[0].id);
  });

  it('makes aliases, case collisions, failed and uncovered units visible and non-shippable', () => {
    const manifest = createReviewUnitManifest({
      identity,
      trustedRules: policy,
      policy,
      files: [
        { path: 'src/App.js', patch: '+one', unitStatus: 'completed' },
        { path: 'src/app.js', patch: '+two', unitStatus: 'completed' },
        { path: './src/../secret.js', patch: '+bad' },
        { path: 'src/failure.js', patch: '+bad', unitStatus: 'failed' },
      ],
    });

    expect(manifest.units.map((unit: any) => unit.status)).toEqual(['unreviewable', 'unreviewable', 'unreviewable', 'failed']);
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.shipEligible).toBe(false);
    expect(manifest.coverage.uncoveredPaths).toEqual(['src/App.js', 'src/app.js', 'src/../secret.js', 'src/failure.js']);
    expect(manifest.summary.uncovered).toBe(4);
  });
});
