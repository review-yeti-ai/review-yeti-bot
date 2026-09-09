import { describe, expect, it } from 'vitest';
import { buildAuthoritativeReviewIdentity, fingerprintEffectiveReviewConfig, fingerprintTrustedReviewPolicy } from '../../src/review/authoritativeReviewIdentity';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { sha256 } from '../../src/review/reviewCore';

const current = { repositoryId: 123, owner: 'example', repo: 'repo', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), open: true, draft: false };
const requested = { repositoryId: 123, owner: 'example', repo: 'repo', prNumber: 42,
  headSha: current.headSha, baseSha: current.baseSha };
const source = { repositoryId: 456, repository: 'example/central-policy', sha: 'c'.repeat(40),
  path: 'policy/review.json', contentDigest: 'd'.repeat(64) };
const prepared = { effectiveConfig: { personas: ['security', 'testing'] }, effectivePolicy: { completeness: 'all' }, sources: [source] };
const policy = fingerprintTrustedReviewPolicy(prepared);

it('lets the worker verify actual configuration without carrying source credentials', () => {
  const config = resolveWorkerConfig({}, { baseUrl: 'https://gateway.example.invalid', apiKey: '', model: 'test-model' });
  const original = fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig: config });
  const updatedSource = fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig: config,
    sources: [{ ...source, sha: 'e'.repeat(40) }] });
  expect(original.effectiveConfigDigest).toBe(fingerprintEffectiveReviewConfig(config));
  expect(updatedSource.effectiveConfigDigest).toBe(original.effectiveConfigDigest);
  expect(updatedSource.effectivePolicyDigest).not.toBe(original.effectivePolicyDigest);
});

describe('trusted immutable admission identity', () => {
  it('binds policy, config, numeric repository and source revision into the run hash', () => {
    const identity = buildAuthoritativeReviewIdentity({ requested, current, policy });
    expect(identity.configDigest).toBe(policy.effectiveConfigDigest);
    expect(identity.reviewPolicy.effectivePolicyDigest).toBe(policy.effectivePolicyDigest);
    const changedPolicy = buildAuthoritativeReviewIdentity({ requested, current,
      policy: { ...policy, effectivePolicyDigest: 'e'.repeat(64) } });
    const changedRepository = buildAuthoritativeReviewIdentity({ requested: { ...requested, repositoryId: 124 },
      current: { ...current, repositoryId: 124 }, policy });
    const changedSource = buildAuthoritativeReviewIdentity({ requested, current,
      policy: { ...policy, sources: [{ ...source, sha: 'f'.repeat(40) }] } });
    for (const changed of [changedPolicy, changedRepository, changedSource]) expect(sha256(changed)).not.toBe(sha256(identity));
  });

  it('keeps readiness out of immutable review identity without promoting a draft', () => {
    const draft = { ...current, draft: true };
    expect(buildAuthoritativeReviewIdentity({ requested, current: draft, policy }))
      .toEqual(buildAuthoritativeReviewIdentity({ requested, current, policy }));
    expect(draft.draft).toBe(true);
  });

  it.each([
    { open: false }, { repositoryId: 124 }, { owner: 'another' }, { repo: 'another' },
    { prNumber: 43 }, { headSha: 'e'.repeat(40) }, { baseSha: 'e'.repeat(40) },
  ])('rejects a stale or closed event hint %j', (change) => {
    expect(() => buildAuthoritativeReviewIdentity({ requested, current: { ...current, ...change }, policy }))
      .toThrow(/current open candidate/u);
  });

  it.each(['default', 'main', 'v1', 'A'.repeat(40)])('rejects mutable or invalid source revision %s', (sha) => {
    expect(() => fingerprintTrustedReviewPolicy({ ...prepared, sources: [{ ...source, sha }] })).toThrow();
  });

  it.each(['/policy.json', '../policy.json', 'policy/../file', 'policy\\file', './policy.json', 'policy//file'])
    ('rejects unsafe source path %s', (path) => {
      expect(() => fingerprintTrustedReviewPolicy({ ...prepared, sources: [{ ...source, path }] })).toThrow();
    });

  it('normalizes source/object ordering and does not mutate source inputs', () => {
    const second = { ...source, repositoryId: 457, repository: 'example/other-policy' };
    const a = fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig: { b: 2, a: 1 }, sources: [source, second] });
    const b = fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig: { a: 1, b: 2 }, sources: [second, source] });
    expect(a).toEqual(b);
    expect(prepared.sources).toEqual([source]);
    expect(() => fingerprintTrustedReviewPolicy({ ...prepared, sources: [source, { ...source }] })).toThrow(/duplicate/u);
  });

  it('fingerprints config and source changes without retaining config content', () => {
    const changed = fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig: { sensitiveField: 'synthetic-private-value' } });
    expect(changed.effectiveConfigDigest).not.toBe(policy.effectiveConfigDigest);
    expect(changed.effectivePolicyDigest).not.toBe(policy.effectivePolicyDigest);
    expect(JSON.stringify(changed)).not.toContain('synthetic-private-value');
  });

  it.each([undefined, null, [], { invalid: undefined }, { invalid: Number.NaN }, { invalid: () => 1 }, new Date()])
    ('rejects unresolved or non-JSON config %j', (effectiveConfig) => {
      expect(() => fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig })).toThrow();
    });

  it('rejects cycles, prototype keys, excessive depth and excessive size', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: object = {}; for (let i = 0; i < 35; i++) deep = { deep };
    for (const effectiveConfig of [cycle, JSON.parse('{"__proto__":{"changed":true}}'), deep, { text: 'x'.repeat(256 * 1024) }]) {
      expect(() => fingerprintTrustedReviewPolicy({ ...prepared, effectiveConfig })).toThrow();
    }
  });
});
