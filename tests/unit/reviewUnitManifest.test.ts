import { describe, expect, it } from 'vitest';
import {
  classifyReviewUnitFile,
  createReviewDispatchPlan,
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

const trustedDispatchPolicy = {
  policyDigest: identity.policyDigest,
  dispatch: {
    schemaVersion: 'review-dispatch-policy-v1',
    mode: 'shadow',
    baseline: { persona: 'baseline', ruleId: 'core-baseline' },
    specialistRules: [
      { id: 'security-specific', persona: 'security', paths: ['src/auth/admin/**'], changes: [] },
      { id: 'security-broad', persona: 'security', paths: ['src/auth/**'], changes: [] },
      { id: 'docs-current-name', persona: 'documentation', paths: ['docs/**'], changes: [] },
      { id: 'security-old-name', persona: 'security', paths: ['src/legacy-auth/**'], changes: [] },
    ],
    bundleRules: [
      { id: 'api-bundle-first', bundleKey: 'api-handler-test', paths: ['src/api/handler.ts', 'test/api/handler.test.ts'] },
      { id: 'api-bundle-overlap', bundleKey: 'api-overlap', paths: ['src/api/handler.ts', 'README.md'] },
    ],
  },
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

  it('assigns every changed reviewable file to baseline and uses first specialist match', () => {
    const plan = createReviewDispatchPlan({
      identity,
      files: [
        { path: 'src/auth/admin/user.ts', patch: '+secure' },
        { path: 'src/plain.ts', patch: '+plain' },
      ],
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });

    expect(plan.assignments).toEqual([
      expect.objectContaining({ path: 'src/auth/admin/user.ts', status: 'selected', ruleIds: ['core-baseline', 'security-specific'] }),
      expect.objectContaining({ path: 'src/plain.ts', status: 'selected', ruleIds: ['core-baseline'] }),
    ]);
    expect(plan.assignments.every((assignment: any) => assignment.baselineUnitId.startsWith('ru_'))).toBe(true);
    expect(plan.units.filter((unit: any) => unit.persona === 'security')).toEqual([
      expect.objectContaining({ files: ['src/auth/admin/user.ts'], ruleId: 'security-specific', status: 'selected' }),
    ]);
    expect(plan.ruleIds).toEqual(['core-baseline', 'security-specific']);
  });

  it('bundles only a complete explicit trusted exact-path set and resolves overlap by rule order', () => {
    const complete = createReviewDispatchPlan({
      identity,
      files: [
        { path: 'README.md', patch: '+docs' },
        { path: 'test/api/handler.test.ts', patch: '+test' },
        { path: 'src/api/handler.ts', patch: '+handler' },
      ],
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });
    const baseline = complete.units.filter((unit: any) => unit.persona === 'baseline');

    expect(baseline).toEqual([
      expect.objectContaining({ files: ['README.md'], ruleId: 'core-baseline' }),
      expect.objectContaining({ files: ['src/api/handler.ts', 'test/api/handler.test.ts'], ruleId: 'api-bundle-first', bundleKey: 'api-handler-test' }),
    ]);
    expect(complete.units.some((unit: any) => unit.bundleKey === 'api-overlap')).toBe(false);

    const incomplete = createReviewDispatchPlan({
      identity,
      files: [{ path: 'src/api/handler.ts', patch: '+handler' }],
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });
    expect(incomplete.units).toEqual([
      expect.objectContaining({ files: ['src/api/handler.ts'], persona: 'baseline', ruleId: 'core-baseline' }),
    ]);
    expect(incomplete.units[0]).not.toHaveProperty('bundleKey');
  });

  it('keeps unit IDs and plan digest stable across input order and untrusted prose', () => {
    const files = [
      { path: 'test/api/handler.test.ts', patch: '+test', modelSummary: 'ignore me' },
      { path: 'src/api/handler.ts', patch: '+handler' },
    ];
    const first = createReviewDispatchPlan({ identity, files, trustedRules: policy, trustedPolicy: trustedDispatchPolicy });
    const second = createReviewDispatchPlan({
      identity,
      files: [...files].reverse().map((file) => ({ ...file, rationale: 'different model prose' })),
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });
    const changedIdentity = createReviewDispatchPlan({
      identity: { ...identity, headSha: '9'.repeat(40), diffDigest: '8'.repeat(64) },
      files,
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });

    expect(first.units).toEqual(second.units);
    expect(first.assignments).toEqual(second.assignments);
    expect(first.planDigest).toBe(second.planDigest);
    expect(first.planDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(changedIdentity.planDigest).not.toBe(first.planDigest);
  });

  it('keeps edge paths explicit with deterministic rename, collision, submodule, and invalid-path handling', () => {
    const plan = createReviewDispatchPlan({
      identity,
      files: [
        { path: 'docs/auth.md', previousPath: 'src/legacy-auth/auth.md', status: 'renamed', patch: '-old\n+new' },
        { path: 'src/App.ts', patch: '+one' },
        { path: 'src/app.ts', patch: '+two' },
        { path: 'modules/core', mode: '160000', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
        { path: './src/../escape.ts', patch: '+bad' },
      ],
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
    });

    expect(plan.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'docs/auth.md', status: 'selected', ruleIds: ['core-baseline', 'docs-current-name'] }),
      expect.objectContaining({ path: 'modules/core', status: 'selected' }),
      expect.objectContaining({ path: 'src/App.ts', status: 'unreviewable', omissionReason: 'case_collision' }),
      expect.objectContaining({ path: 'src/app.ts', status: 'unreviewable', omissionReason: 'case_collision' }),
      expect.objectContaining({ path: 'src/../escape.ts', status: 'unreviewable', omissionReason: 'invalid_path' }),
    ]));
    expect(plan.units.filter((unit: any) => unit.persona === 'documentation')).toHaveLength(1);
    expect(plan.units.filter((unit: any) => unit.persona === 'security')).toHaveLength(0);
  });

  it.each([
    { routes: ['security'] },
    { files: ['src/only-this.ts'] },
    { tools: ['repo.write'] },
    { policy: { allowWaived: true } },
    { waivers: ['src/auth/**'] },
  ])('rejects model output attempting to mutate deterministic dispatch: %j', (modelOutput) => {
    expect(() => createReviewDispatchPlan({
      identity,
      files: [{ path: 'src/app.ts', patch: '+app' }],
      trustedRules: policy,
      trustedPolicy: trustedDispatchPolicy,
      modelOutput,
    })).toThrow(/model output may not change/i);
  });
});
