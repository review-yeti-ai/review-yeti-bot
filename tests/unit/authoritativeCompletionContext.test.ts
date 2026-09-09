import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { AuthoritativePublishingResolver } from '../../src/review/authoritativePublishingResolver';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';
import { deriveCanonicalWorkerReviewEvidence } from '../../src/review/workerReviewCompletion';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';

const target = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
const current = { ...target, open: true, draft: false };
const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const privateText = 'ghs_SYNTHETIC_PRIVATE_CONTEXT_MARKER';
function policyFile(turns = 3) {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: turns },
  } });
  return { content, source: { repositoryId: 456, repository: 'example/central-policy',
    sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } };
}
function prepared(turns = 3) {
  return preparePublishingPolicy(policyFile(turns),
  { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
}
function resolution(policy = prepared()) {
  return { current: { ...current }, prepared: policy,
    identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: policy.policy }) };
}
function fixture(overrides: Partial<AuthoritativeCompletionContextOptions> = {}) {
  const stored = prepared();
  const gate: StoredReviewGate = {
    coordinates: { ...target, runId: `run_${'1'.repeat(32)}`, policyDigest: stored.policy.effectivePolicyDigest,
      attemptId: `run_${'1'.repeat(32)}-g0-e2`, executionAttempt: 2 },
    reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
    creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
  };
  const getStoredPrepared = vi.fn<AuthoritativeCompletionContextOptions['getStoredPrepared']>(async () => stored);
  const currentCandidate = vi.fn(async () => ({ ...current }));
  const exactCurrentDiff = vi.fn(async () => ({ current: { ...current }, diff, expectedFileCount: 1 as number | undefined }));
  const readerFactory = vi.fn<AuthoritativeCompletionContextOptions['readerFactory']>(async () => ({ currentCandidate, exactCurrentDiff }));
  const resolve = vi.fn<AuthoritativeCompletionContextOptions['publishingResolver']['resolve']>(async () => resolution());
  const options = { getStoredPrepared, readerFactory, publishingResolver: { resolve }, ...overrides };
  return { context: createAuthoritativeCompletionContext(options), options, gate, stored,
    getStoredPrepared, currentCandidate, exactCurrentDiff, readerFactory, resolve };
}
async function rejected(pending: Promise<unknown>): Promise<Error> {
  try { await pending; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error('Expected rejection');
}
function redacted(error: Error) {
  expect(error.message).toBe('Authoritative completion context unavailable');
  expect(error.cause).toBeUndefined();
  expect(`${error.stack}\n${JSON.stringify(error)}`).not.toContain(privateText);
}

describe('service-owned authoritative completion context', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); } });

  it.each([false, true])('returns only trusted current/coverage while preserving draft=%s', async (draft) => {
    const f = fixture();
    f.exactCurrentDiff.mockResolvedValue({ current: { ...current, draft }, diff, expectedFileCount: 1 });
    const context = await f.context(f.gate);
    expect(context).toEqual({ current: { ...current, draft, policyDigest: f.gate.coordinates.policyDigest }, coverage: {
      expectedPersonaIds: ['sec-lane', 'qual-lane'], changedFiles: [{ path: 'src/a.ts', patch: diff }],
      coverageComplete: true, quorumSatisfied: true,
    } });
    expect(context).not.toHaveProperty('evidence');
    expect(context).not.toHaveProperty('verdict');
    expect(JSON.stringify(context)).not.toContain(privateText);
    expect(f.getStoredPrepared).toHaveBeenCalledExactlyOnceWith(f.gate.coordinates.policyDigest, expect.any(AbortSignal));
    expect(f.readerFactory).toHaveBeenCalledExactlyOnceWith({ repositoryId: 123, owner: 'example', repo: 'candidate' }, expect.any(AbortSignal));
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(target);
    expect(f.exactCurrentDiff).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));
    const order = [f.getStoredPrepared, f.readerFactory, f.currentCandidate, f.resolve, f.exactCurrentDiff]
      .map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(f.readerFactory.mock.calls[0][1].aborted).toBe(true);
  });

  it('does not turn a trusted required-lane contract into successful worker evidence', async () => {
    const f = fixture();
    const context = await f.context(f.gate);
    const { attemptId: _, ...coordinates } = f.gate.coordinates;
    const expectedCoordinates = { ...coordinates, configDigest: f.stored.policy.effectiveConfigDigest };
    const derived = deriveCanonicalWorkerReviewEvidence({ version: 'WorkerReviewCompletion.v1', ...expectedCoordinates,
      result: { version: 'WorkerReviewResult.v1', completedAt: '2026-09-09T18:00:00Z', coverageComplete: true,
        quorumSatisfied: true, personas: [{ id: 'sec-lane', decision: 'APPROVE', findings: [] }] } },
    { ...context.coverage, expectedCoordinates });
    expect(derived.valid).toBe(true);
    expect(derived.evidence?.quorumSatisfied).toBe(false);
    expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current, evidence: derived.evidence }).status).toBe('failure');
  });

  it('refreshes through the existing configured publishing resolver without candidate-selected policy', async () => {
    const policyRepository = { repositoryId: 456, owner: 'example', repo: 'central-policy' };
    const resolvePolicyRevision = vi.fn(async () => 'c'.repeat(40));
    const immutablePolicyFile = vi.fn(async () => policyFile());
    const policyReaderFactory = vi.fn(async () => ({ resolvePolicyRevision, immutablePolicyFile }));
    const candidateRead = vi.fn(async () => ({ ...current }));
    const publishingResolver = new AuthoritativePublishingResolver({
      policyRepository, policyRef: 'refs/heads/service-policy', policyPath: 'policy/review.json',
      transport: prepared().transport, candidateReaderFactory: async () => ({ currentCandidate: candidateRead }),
      policyReaderFactory, timeoutMs: 250,
    });
    const f = fixture({ publishingResolver });
    expect((await f.context(f.gate)).coverage.coverageComplete).toBe(true);
    expect(candidateRead).toHaveBeenCalledTimes(2);
    expect(policyReaderFactory).toHaveBeenCalledExactlyOnceWith(policyRepository, expect.any(AbortSignal));
    expect(resolvePolicyRevision).toHaveBeenCalledExactlyOnceWith(policyRepository, 'refs/heads/service-policy');
    expect(immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(policyRepository, 'c'.repeat(40), 'policy/review.json');
  });

  it('aborts a real reader stalled body at the context deadline, even with a longer reader timeout', async () => {
    const pull = () => new Response(JSON.stringify({ number: 42, state: 'open', merged: false, draft: false,
      head: { sha: target.headSha }, base: { sha: target.baseSha, repo: { id: 123, full_name: 'example/candidate' } },
      changed_files: 1 }));
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(pull()).mockResolvedValueOnce(pull())
      .mockResolvedValueOnce(new Response(body));
    const reader = new AuthoritativeReviewReader({ token: 'ghs_context_read_only', timeoutMs: 5_000, fetchImplementation: fetcher });
    const f = fixture({ readerFactory: async () => reader, timeoutMs: 250 });
    const pending = rejected(f.context(f.gate));
    await vi.advanceTimersByTimeAsync(249); expect(body.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(1); redacted(await pending);
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3); expect(fetcher.mock.calls[2][1]?.signal?.aborted).toBe(true);
  });

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'cancels a fresh changed/closed candidate %j without policy or diff reads', async (change) => {
      const f = fixture(); f.currentCandidate.mockResolvedValue({ ...current, ...change });
      const context = await f.context(f.gate);
      expect(context.current).toEqual({ ...current, ...change, policyDigest: f.gate.coordinates.policyDigest });
      expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
      expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current }).status).toBe('cancelled');
      expect(f.resolve).not.toHaveBeenCalled(); expect(f.exactCurrentDiff).not.toHaveBeenCalled();
    },
  );

  it('returns fresh changed policy identity for cancellation without fetching a diff', async () => {
    const f = fixture(); const fresh = prepared(4); f.resolve.mockResolvedValue(resolution(fresh));
    const context = await f.context(f.gate);
    expect(context.current.policyDigest).toBe(fresh.policy.effectivePolicyDigest);
    expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
    expect(evaluateReviewGate({ candidate: f.gate.coordinates, current: context.current }).status).toBe('cancelled');
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'returns cancellation for a resolver-time candidate race %j only after fresh readback', async (change) => {
      const f = fixture(); f.resolve.mockRejectedValue(new Error(privateText));
      f.currentCandidate.mockResolvedValueOnce(current).mockResolvedValueOnce({ ...current, ...change });
      const context = await f.context(f.gate);
      expect(context.current).toMatchObject(change);
      expect(context.coverage.coverageComplete).toBe(false);
      expect(f.exactCurrentDiff).not.toHaveBeenCalled();
    },
  );

  it.each([{ open: false }, { headSha: 'd'.repeat(40) }, { baseSha: 'e'.repeat(40) }])(
    'discards all diff evidence after a final candidate race %j', async (change) => {
      const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current: { ...current, ...change }, diff, expectedFileCount: 1 });
      const context = await f.context(f.gate);
      expect(context.current).toMatchObject(change);
      expect(context.coverage).toMatchObject({ changedFiles: [], coverageComplete: false, quorumSatisfied: false });
    },
  );

  it.each([{ repositoryId: 999 }, { owner: 'other' }, { repo: 'other' }, { prNumber: 43 }, { headSha: 'main' }])(
    'rejects wrong repository/PR or malformed current coordinates %j', async (change) => {
      const f = fixture(); f.currentCandidate.mockResolvedValue({ ...current, ...change });
      redacted(await rejected(f.context(f.gate)));
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['initial', 'final'] as const)('rejects wrong repository identity in %s returned evidence', async (stage) => {
    const f = fixture();
    if (stage === 'initial') f.resolve.mockResolvedValue({ ...resolution(), current: { ...current, repositoryId: 999 } });
    else f.exactCurrentDiff.mockResolvedValue({ current: { ...current, repositoryId: 999 }, diff, expectedFileCount: 1 });
    redacted(await rejected(f.context(f.gate)));
  });

  it.each(['missing', 'version', 'digest', 'config', 'transport', 'empty-personas', 'extra-persona', 'duplicate-persona', 'source'])(
    'rejects %s stored preparation before minting a token', async (kind) => {
      const f = fixture(); const bad = structuredClone(f.stored);
      if (kind === 'missing') f.getStoredPrepared.mockResolvedValue(null);
      if (kind === 'version') (bad as any).version = 'unknown';
      if (kind === 'digest') bad.policy.effectivePolicyDigest = 'f'.repeat(64);
      if (kind === 'config') bad.config.profile = 'chill';
      if (kind === 'transport') bad.transport.model = 'other';
      if (kind === 'empty-personas') bad.expectedPersonaIds = [];
      if (kind === 'extra-persona') bad.expectedPersonaIds = ['sec-lane', 'unrequired'];
      if (kind === 'duplicate-persona') bad.expectedPersonaIds = ['sec-lane', 'sec-lane'];
      if (kind === 'source') bad.policy.sources[0].sha = privateText;
      if (kind !== 'missing') f.getStoredPrepared.mockResolvedValue(bad);
      redacted(await rejected(f.context(f.gate)));
      expect(f.readerFactory).not.toHaveBeenCalled();
    },
  );

  it('rejects corrupted stored provenance even if its claimed policy digest matches', async () => {
    const f = fixture(); f.stored.policy.sources[0].sha = 'f'.repeat(40);
    redacted(await rejected(f.context(f.gate)));
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('rejects a refreshed identity inconsistent with the fresh prepared policy', async () => {
    const f = fixture(); const result = resolution(); result.identity.configDigest = 'f'.repeat(64);
    f.resolve.mockResolvedValue(result);
    redacted(await rejected(f.context(f.gate)));
    expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it.each([
    { diff, expectedFileCount: undefined }, { diff, expectedFileCount: 0 }, { diff, expectedFileCount: 2 },
    { diff: diff + 'diff --git nonsense\n@@ -1 +1 @@\n-old\n+new\n', expectedFileCount: 2 },
    { diff: diff + diff, expectedFileCount: 2 },
  ])('never asserts complete coverage for missing/count-mismatched/unreadable diff evidence %#', async (source) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, ...source });
    expect((await f.context(f.gate)).coverage.coverageComplete).toBe(false);
  });

  it.each(['', 'not a diff', 'diff --git nonsense\n@@ -1 +1 @@\n-old\n+new\n'])(
    'rejects same-head evidence with no readable files rather than manufacturing an exemption %#', async (diff) => {
      const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, diff, expectedFileCount: 0 });
      redacted(await rejected(f.context(f.gate)));
    },
  );

  it.each([2_000_001, 512_001])('rejects oversized diff/individual patch (%i bytes) rather than truncating it', async (size) => {
    const f = fixture(); f.exactCurrentDiff.mockResolvedValue({ current, diff: diff + 'a'.repeat(size), expectedFileCount: 1 });
    redacted(await rejected(f.context(f.gate)));
  });

  it.each(['storage', 'factory', 'current', 'policy', 'diff'])('redacts %s failures', async (stage) => {
    const f = fixture(); const fail = new Error(privateText);
    if (stage === 'storage') f.getStoredPrepared.mockRejectedValue(fail);
    if (stage === 'factory') f.readerFactory.mockRejectedValue(fail);
    if (stage === 'current') f.currentCandidate.mockRejectedValue(fail);
    if (stage === 'policy') f.resolve.mockRejectedValue(fail);
    if (stage === 'diff') f.exactCurrentDiff.mockRejectedValue(fail);
    redacted(await rejected(f.context(f.gate)));
  });

  it.each(['storage', 'factory', 'current', 'policy', 'diff'])('bounds a non-cooperative %s promise at 10 seconds', async (stage) => {
    const f = fixture(); const hang = () => new Promise<never>(() => undefined);
    if (stage === 'storage') f.getStoredPrepared.mockImplementation(hang);
    if (stage === 'factory') f.readerFactory.mockImplementation(hang);
    if (stage === 'current') f.currentCandidate.mockImplementation(hang);
    if (stage === 'policy') f.resolve.mockImplementation(hang);
    if (stage === 'diff') f.exactCurrentDiff.mockImplementation(hang);
    let settled = false;
    const pending = rejected(f.context(f.gate)).then((error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(9_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); redacted(await pending);
    expect(f.getStoredPrepared.mock.calls[0][1].aborted).toBe(true);
    if (stage !== 'diff') expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('does not resume policy/diff reads after a timed-out token mint finally resolves', async () => {
    const f = fixture({ timeoutMs: 250 });
    let finish!: (reader: Awaited<ReturnType<AuthoritativeCompletionContextOptions['readerFactory']>>) => void;
    f.readerFactory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    finish({ currentCandidate: f.currentCandidate, exactCurrentDiff: f.exactCurrentDiff });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.currentCandidate).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
  });

  it('does not fetch a diff or re-read the candidate after a late policy resolution', async () => {
    const f = fixture({ timeoutMs: 250 });
    let finish!: (value: ReturnType<typeof resolution>) => void;
    f.resolve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    finish(resolution()); await vi.advanceTimersByTimeAsync(0);
    expect(f.currentCandidate).toHaveBeenCalledOnce(); expect(f.exactCurrentDiff).not.toHaveBeenCalled();
  });

  it('uses one cumulative deadline rather than restarting it for each dependency', async () => {
    const f = fixture({ timeoutMs: 250 });
    f.getStoredPrepared.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return f.stored; });
    f.readerFactory.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150)); return { currentCandidate: f.currentCandidate, exactCurrentDiff: f.exactCurrentDiff };
    });
    const pending = rejected(f.context(f.gate)); await vi.advanceTimersByTimeAsync(250); redacted(await pending);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.currentCandidate).not.toHaveBeenCalled();
  });

  it.each([249, 10_001, 1.5, NaN, Infinity])('rejects invalid operation deadline %s', (timeoutMs) => {
    expect(() => fixture({ timeoutMs })).toThrow('Authoritative completion context configuration invalid');
  });
});
