import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRepositoryIdentity } from '../../src/github/authoritativeReviewReader';
import { AuthoritativePublishingResolver, type AuthoritativePublishingResolverOptions } from '../../src/review/authoritativePublishingResolver';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy, verifyPreparedPublishingConfig } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';

const requested = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const current = { ...requested, open: true, draft: false };
const policyRepository = { repositoryId: 456, owner: 'example', repo: 'central-policy' };
const policyRef = 'refs/heads/service-policy';
const policyPath = 'policy/review.json';
const revision = 'c'.repeat(40);
const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' };
const secret = 'ghs_SYNTHETIC_PRIVATE_MARKER';
const rawPolicy = { schema: 'calltelemetry.review-policy.v1', review_yeti: {
  personas: 'security,testing', budget: { max_investigation_turns: 20 }, private_marker: secret,
} };

function file(content = JSON.stringify(rawPolicy)) {
  return { content, source: { repositoryId: policyRepository.repositoryId,
    repository: `${policyRepository.owner}/${policyRepository.repo}`, sha: revision, path: policyPath,
    contentDigest: createHash('sha256').update(content).digest('hex') } };
}

function fixture(overrides: Partial<AuthoritativePublishingResolverOptions> = {}) {
  const currentCandidate = vi.fn(async () => ({ ...current }));
  const resolvePolicyRevision = vi.fn(async () => revision);
  const immutablePolicyFile = vi.fn(async () => file());
  const candidateReaderFactory = vi.fn(async (_repository: ReviewRepositoryIdentity, _signal: AbortSignal) => ({ currentCandidate }));
  const policyReaderFactory = vi.fn(async (_repository: ReviewRepositoryIdentity, _signal: AbortSignal) => ({ resolvePolicyRevision, immutablePolicyFile }));
  const options = { policyRepository: { ...policyRepository }, policyRef, policyPath, transport: { ...transport },
    candidateReaderFactory, policyReaderFactory, timeoutMs: 250, ...overrides };
  return { resolver: new AuthoritativePublishingResolver(options), options, currentCandidate,
    resolvePolicyRevision, immutablePolicyFile, candidateReaderFactory, policyReaderFactory };
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
  try { await pending; } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected resolution to reject');
}

function expectRedacted(error: Error) {
  expect(error.message).toBe('Authoritative publishing resolution unavailable');
  expect(`${error.stack}\n${JSON.stringify(error)}`).not.toContain(secret);
  expect(error.cause).toBeUndefined();
}

const candidateChanges = [
  { repositoryId: 999 }, { owner: 'different' }, { repo: 'different' }, { prNumber: 43 },
  { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }, { open: false },
];

describe('AuthoritativePublishingResolver', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => {
    try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('prepares the exact current candidate without promoting draft=%s', async (draft) => {
    const f = fixture();
    f.currentCandidate.mockResolvedValue({ ...current, draft });
    const result = await f.resolver.resolve(requested);
    const prepared = preparePublishingPolicy(file(), transport);
    expect(result).toEqual({ current: { ...current, draft }, prepared,
      identity: buildAuthoritativeReviewIdentity({ requested, current, policy: prepared.policy }) });
    expect(result.prepared.expectedPersonaIds).toEqual(['sec-lane', 'qual-lane']);
    expect(verifyPreparedPublishingConfig(result.prepared.config, result.identity.configDigest, transport)).toEqual(prepared.config);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.keys(result).sort()).toEqual(['current', 'identity', 'prepared']);
    expect(f.candidateReaderFactory).toHaveBeenCalledExactlyOnceWith(
      { repositoryId: requested.repositoryId, owner: requested.owner, repo: requested.repo }, expect.any(AbortSignal));
    expect(f.policyReaderFactory).toHaveBeenCalledExactlyOnceWith(policyRepository, expect.any(AbortSignal));
    expect(f.currentCandidate).toHaveBeenNthCalledWith(1, { repositoryId: requested.repositoryId,
      owner: requested.owner, repo: requested.repo, prNumber: requested.prNumber });
    expect(f.currentCandidate).toHaveBeenNthCalledWith(2, { repositoryId: requested.repositoryId,
      owner: requested.owner, repo: requested.repo, prNumber: requested.prNumber });
    expect(f.resolvePolicyRevision).toHaveBeenCalledExactlyOnceWith(policyRepository, policyRef);
    expect(f.immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(policyRepository, revision, policyPath);
    const order = [f.candidateReaderFactory.mock.invocationCallOrder[0], f.currentCandidate.mock.invocationCallOrder[0],
      f.policyReaderFactory.mock.invocationCallOrder[0], f.resolvePolicyRevision.mock.invocationCallOrder[0],
      f.immutablePolicyFile.mock.invocationCallOrder[0], f.currentCandidate.mock.invocationCallOrder[1]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('returns readiness from the final read while leaving immutable identity unchanged', async () => {
    const f = fixture();
    f.currentCandidate.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, draft: true });
    const result = await f.resolver.resolve(requested);
    expect(result.current.draft).toBe(true);
    expect(result.identity).toEqual(buildAuthoritativeReviewIdentity({ requested, current, policy: result.prepared.policy }));
  });

  it.each(candidateChanges)('rejects initially wrong/closed candidate %j before central reads', async (change) => {
    const f = fixture();
    f.currentCandidate.mockResolvedValueOnce({ ...current, ...change });
    expectRedacted(await rejection(f.resolver.resolve(requested)));
    expect(f.policyReaderFactory).not.toHaveBeenCalled();
  });

  it.each(candidateChanges)('rejects candidate changes during policy reads %j', async (change) => {
    const f = fixture();
    f.currentCandidate.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, ...change });
    expectRedacted(await rejection(f.resolver.resolve(requested)));
    expect(f.immutablePolicyFile).toHaveBeenCalledOnce();
    expect(f.currentCandidate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { repositoryId: 0 }, { owner: '..' }, { repo: 'candidate/other' }, { prNumber: 0 }, { headSha: 'main' },
    { baseSha: 'A'.repeat(40) }, { policyRepository }, { policyRef: 'candidate-selected' }, { policyPath: 'untrusted.json' },
    { transport: { baseUrl: `https://${secret}@untrusted.invalid`, model: 'untrusted' } }, { token: secret },
  ])('rejects invalid coordinates or candidate-selected authority %j before factories', async (change) => {
    const f = fixture();
    expectRedacted(await rejection(f.resolver.resolve({ ...requested, ...change })));
    expect(f.candidateReaderFactory).not.toHaveBeenCalled();
    expect(f.policyReaderFactory).not.toHaveBeenCalled();
  });

  it('snapshots constructor-owned selection without retaining the options object', async () => {
    const f = fixture();
    f.options.policyRepository.repositoryId = 999;
    f.options.policyRepository.repo = 'untrusted';
    f.options.policyRef = 'untrusted'; f.options.policyPath = 'untrusted.json';
    f.options.transport.model = 'untrusted'; f.options.transport.baseUrl = 'https://untrusted.invalid';
    f.options.policyReaderFactory = async () => { throw new Error(secret); };
    const result = await f.resolver.resolve(requested);
    expect(f.policyReaderFactory).toHaveBeenCalledExactlyOnceWith(policyRepository, expect.any(AbortSignal));
    expect(f.resolvePolicyRevision).toHaveBeenCalledExactlyOnceWith(policyRepository, policyRef);
    expect(f.immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(policyRepository, revision, policyPath);
    expect(result.prepared.transport).toEqual(transport);
  });

  it.each(['candidateFactory', 'candidate', 'policyFactory', 'revision', 'file', 'recheck'] as const)(
    'redacts upstream failure at %s', async (stage) => {
      const f = fixture();
      const error = new Error(`Authorization: Bearer ${secret}; private response`);
      if (stage === 'candidateFactory') f.candidateReaderFactory.mockRejectedValueOnce(error);
      if (stage === 'candidate') f.currentCandidate.mockRejectedValueOnce(error);
      if (stage === 'policyFactory') f.policyReaderFactory.mockRejectedValueOnce(error);
      if (stage === 'revision') f.resolvePolicyRevision.mockRejectedValueOnce(error);
      if (stage === 'file') f.immutablePolicyFile.mockRejectedValueOnce(error);
      if (stage === 'recheck') f.currentCandidate.mockResolvedValueOnce(current).mockRejectedValueOnce(error);
      expectRedacted(await rejection(f.resolver.resolve(requested)));
    });

  it.each([
    { repositoryId: 999 }, { repository: 'example/untrusted' }, { sha: 'd'.repeat(40) },
    { path: 'untrusted.json' }, { contentDigest: 'e'.repeat(64) },
  ])('rejects a policy file with unbound provenance %j', async (change) => {
    const f = fixture(); const input = file();
    f.immutablePolicyFile.mockResolvedValue({ ...input, source: { ...input.source, ...change } });
    expectRedacted(await rejection(f.resolver.resolve(requested)));
    expect(f.currentCandidate).toHaveBeenCalledOnce();
  });

  it.each(['main', 'A'.repeat(40)])('never reads a policy file at invalid revision %s', async (value) => {
    const f = fixture(); f.resolvePolicyRevision.mockResolvedValue(value);
    expectRedacted(await rejection(f.resolver.resolve(requested)));
    expect(f.immutablePolicyFile).not.toHaveBeenCalled();
  });

  it('redacts malformed policy content even when its provenance digest matches', async () => {
    const f = fixture(); f.immutablePolicyFile.mockResolvedValue(file(`not-json-${secret}`));
    expectRedacted(await rejection(f.resolver.resolve(requested)));
    expect(f.currentCandidate).toHaveBeenCalledOnce();
  });

  it('fresh-resolves central provenance on every call without changing the config digest for identical content', async () => {
    const f = fixture();
    const first = await f.resolver.resolve(requested);
    const nextRevision = 'd'.repeat(40);
    f.resolvePolicyRevision.mockResolvedValue(nextRevision);
    const input = file(); input.source.sha = nextRevision;
    f.immutablePolicyFile.mockResolvedValue(input);
    const second = await f.resolver.resolve(requested);
    expect(second.identity.configDigest).toBe(first.identity.configDigest);
    expect(second.identity.reviewPolicy.sources[0].sha).toBe(nextRevision);
    expect(sha256(second.identity)).not.toBe(sha256(first.identity));
    expect(f.candidateReaderFactory).toHaveBeenCalledTimes(2);
    expect(f.policyReaderFactory).toHaveBeenCalledTimes(2);
    expect(f.currentCandidate).toHaveBeenCalledTimes(4);
  });

  it.each(['personas', 'model', 'transport'] as const)('binds effective %s changes into config and run identity', async (change) => {
    const baseline = await fixture().resolver.resolve(requested);
    const f = fixture({ transport: change === 'model' ? { ...transport, model: 'other-model' }
      : change === 'transport' ? { ...transport, baseUrl: 'https://other-gateway.example.invalid/v1' } : transport });
    if (change === 'personas') f.immutablePolicyFile.mockResolvedValue(file(JSON.stringify({ ...rawPolicy,
      review_yeti: { ...rawPolicy.review_yeti, personas: 'security,architecture' } })));
    const result = await f.resolver.resolve(requested);
    expect(result.identity.configDigest).not.toBe(baseline.identity.configDigest);
    expect(sha256(result.identity)).not.toBe(sha256(baseline.identity));
    expect(result.prepared.policy.effectiveConfigDigest).toBe(result.identity.configDigest);
  });

  it.each([249, 30_001, 250.5, NaN, Infinity])('rejects invalid whole-resolution timeout %s', (timeoutMs) => {
    expect(() => fixture({ timeoutMs })).toThrow('Authoritative publishing resolver configuration invalid');
  });

  it.each([
    { policyRepository: { ...policyRepository, repositoryId: 0 } }, { policyRef: '' }, { policyPath: '../policy.json' },
    { transport: { ...transport, baseUrl: `https://user:${secret}@gateway.example.invalid` } },
    { transport: { ...transport, baseUrl: `https://gateway.example.invalid?token=${secret}` } },
    { transport: { ...transport, apiKey: secret } },
  ])('rejects invalid service configuration without persisting or echoing credentials %j', (change) => {
    let error: unknown;
    try { fixture(change); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Authoritative publishing resolver configuration invalid');
    expect(`${(error as Error).stack}\n${JSON.stringify(error)}`).not.toContain(secret);
  });

  it.each(['candidateFactory', 'candidate', 'policyFactory', 'revision', 'file', 'recheck'] as const)(
    'bounds an uncooperative %s by the whole deadline', async (stage) => {
      const f = fixture(); const hang = () => new Promise<never>(() => undefined);
      if (stage === 'candidateFactory') f.candidateReaderFactory.mockImplementation(hang);
      if (stage === 'candidate') f.currentCandidate.mockImplementation(hang);
      if (stage === 'policyFactory') f.policyReaderFactory.mockImplementation(hang);
      if (stage === 'revision') f.resolvePolicyRevision.mockImplementation(hang);
      if (stage === 'file') f.immutablePolicyFile.mockImplementation(hang);
      if (stage === 'recheck') f.currentCandidate.mockResolvedValueOnce(current).mockImplementationOnce(hang);
      const pending = rejection(f.resolver.resolve(requested));
      const settled = vi.fn(); void pending.then(settled);
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expectRedacted(await pending);
      expect(f.candidateReaderFactory.mock.calls[0][1].aborted).toBe(true);
      if (f.policyReaderFactory.mock.calls.length) expect(f.policyReaderFactory.mock.calls[0][1].aborted).toBe(true);
    });

  it('uses one cumulative budget rather than resetting it between stages', async () => {
    const f = fixture();
    const delayed = async <T>(value: T) => { await new Promise<void>((resolve) => setTimeout(resolve, 60)); return value; };
    f.candidateReaderFactory.mockImplementation(() => delayed({ currentCandidate: f.currentCandidate }));
    f.currentCandidate.mockImplementation(() => delayed(current));
    f.policyReaderFactory.mockImplementation(() => delayed({ resolvePolicyRevision: f.resolvePolicyRevision, immutablePolicyFile: f.immutablePolicyFile }));
    f.resolvePolicyRevision.mockImplementation(() => delayed(revision));
    f.immutablePolicyFile.mockImplementation(() => new Promise<never>(() => undefined));
    const pending = rejection(f.resolver.resolve(requested));
    await vi.advanceTimersByTimeAsync(250);
    expectRedacted(await pending);
    expect(f.immutablePolicyFile).toHaveBeenCalledOnce();
    expect(f.currentCandidate).toHaveBeenCalledOnce();
  });

  it('does not continue reading if an uncooperative token factory resolves after timeout', async () => {
    const f = fixture();
    let finish!: (reader: { currentCandidate: typeof f.currentCandidate }) => void;
    f.candidateReaderFactory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = rejection(f.resolver.resolve(requested));
    await vi.advanceTimersByTimeAsync(250);
    expectRedacted(await pending);
    finish({ currentCandidate: f.currentCandidate });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.currentCandidate).not.toHaveBeenCalled();
    expect(f.policyReaderFactory).not.toHaveBeenCalled();
  });
});
