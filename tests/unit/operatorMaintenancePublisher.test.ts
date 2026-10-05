import { describe, expect, it, vi } from 'vitest';
import type { OperatorMaintenanceRepository, OperatorMaintenanceReceiptV1 } from '../../src/review/operatorMaintenanceContracts';
import { OperatorMaintenanceTargetChangedError } from '../../src/review/operatorMaintenanceContracts';
import type { AuthoritativePublishingResolution, RequestedReviewCandidate } from '../../src/review/authoritativePublishingResolver';
import { OperatorMaintenancePublisher } from '../../src/review/operatorMaintenancePublisher';
import type { OperatorMaintenanceCheckInput, OperatorMaintenanceCheckObservation } from '../../src/github/installationClient';

const REPOSITORY_ID = 610_001;
const APP_ID = 4_385_771;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLICY_SOURCE = {
  repositoryId: 610_002,
  repository: 'review-yeti-ai/review-yeti-actions',
  sha: 'c'.repeat(40),
  path: 'policy/review-yeti.json',
  contentDigest: 'd'.repeat(64),
};
const candidate: RequestedReviewCandidate = {
  repositoryId: REPOSITORY_ID, owner: 'review-yeti-ai', repo: 'sample', prNumber: 27,
  headSha: HEAD, baseSha: BASE,
};

function resolution(target: RequestedReviewCandidate = candidate): AuthoritativePublishingResolution {
  return {
    current: { ...target, open: true, draft: false },
    identity: {} as AuthoritativePublishingResolution['identity'],
    prepared: { policy: {
      effectivePolicyDigest: 'e'.repeat(64), effectiveConfigDigest: 'f'.repeat(64), sources: [POLICY_SOURCE],
    } } as AuthoritativePublishingResolution['prepared'],
  };
}

function memoryRepository(now: () => number) {
  const state: { receipt?: OperatorMaintenanceReceiptV1; raw?: number; gate?: number;
    rawLease?: { token: string; expires: number }; gateLease?: { token: string; expires: number };
    stale?: boolean; published?: boolean } = {};
  let sequence = 0;
  const makeClaim = (stage: 'raw' | 'gate') => {
    if (state.stale) return { kind: 'stale' as const };
    if (stage === 'gate' && state.raw === undefined) return { kind: 'blocked' as const };
    const bound = stage === 'raw' ? state.raw : state.gate;
    if (bound !== undefined) return { kind: 'bound' as const, checkId: bound };
    const lease = stage === 'raw' ? state.rawLease : state.gateLease;
    if (lease && lease.expires > now()) return { kind: 'busy' as const };
    const next = { token: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, expires: now() + 1_000 };
    if (stage === 'raw') state.rawLease = next; else state.gateLease = next;
    return { kind: 'lease' as const, leaseToken: next.token, reconcileFirst: true as const };
  };
  const repo: OperatorMaintenanceRepository = {
    async reserve(receipt) { state.receipt ??= receipt; return state.receipt; },
    async listPending(limit) { return limit > 0 && state.receipt && !state.stale && !state.published ? [state.receipt] : []; },
    async claimRaw() { return makeClaim('raw'); },
    async bindRaw(_intent, token, checkId) {
      if (state.rawLease?.token !== token) throw new Error('raw lease mismatch');
      state.raw = checkId; state.rawLease = undefined;
    },
    async claimGate() { return makeClaim('gate'); },
    async bindGate(_intent, token, checkId) {
      if (state.gateLease?.token !== token) throw new Error('gate lease mismatch');
      state.gate = checkId; state.gateLease = undefined; state.published = true;
    },
    async markStale() { state.stale = true; },
  };
  return { repo, state };
}

function clientFixture() {
  const checks = new Map<string, OperatorMaintenanceCheckObservation & { title: string; summary: string }>();
  const posts = { raw: 0, gate: 0 };
  const completions = { raw: 0, gate: 0 };
  let nextId = 100;
  let loseAck: 'raw' | 'gate' | undefined;
  const key = (input: OperatorMaintenanceCheckInput) => input.externalId;
  const client = {
    reconcileOperatorMaintenanceCheck: vi.fn(async (input: OperatorMaintenanceCheckInput) => {
      const found = checks.get(key(input));
      if (!found) return undefined;
      if (found.name !== input.name || found.headSha !== input.headSha || found.appId !== input.expectedAppId
        || found.title !== input.title || found.summary !== input.summary) throw new Error('exact check mismatch');
      return { id: found.id, name: found.name, appId: found.appId, headSha: found.headSha,
        externalId: found.externalId, state: found.state };
    }),
    completeOperatorMaintenanceCheck: vi.fn(async (input: OperatorMaintenanceCheckInput, checkId: number) => {
      const found = checks.get(key(input));
      if (!found || found.id !== checkId || found.state !== 'in_progress') throw new Error('cannot complete foreign check');
      completions[input.externalId.endsWith(':raw') ? 'raw' : 'gate'] += 1;
      found.state = 'completed';
      return { id: found.id, name: found.name, appId: found.appId, headSha: found.headSha,
        externalId: found.externalId, state: 'completed' as const };
    }),
    publishOperatorMaintenanceCheck: vi.fn(async (input: OperatorMaintenanceCheckInput) => {
      const stage = input.externalId.endsWith(':raw') ? 'raw' : 'gate';
      posts[stage] += 1;
      const observation = { id: nextId++, name: input.name, appId: input.expectedAppId,
        headSha: input.headSha, externalId: input.externalId, state: 'completed' as const,
        title: input.title, summary: input.summary };
      if (loseAck === stage) {
        loseAck = undefined;
        checks.set(key(input), { ...observation, state: 'in_progress' });
        throw new Error('simulated lost create acknowledgement');
      }
      checks.set(key(input), observation);
      return observation;
    }),
    loseAcknowledgement(stage: 'raw' | 'gate') { loseAck = stage; },
    checks,
    posts,
    completions,
  };
  return client;
}

function setup(options: { now?: () => number; movedOnCall?: number;
  movedCurrent?: boolean;
  verifyMergeGroupCurrent?: (identity: any, policyResolution: any) => Promise<void> } = {}) {
  let currentTime = 1_800_000_000_000;
  const now = options.now || (() => currentTime);
  let resolverCalls = 0;
  const resolver = {
    resolve: vi.fn(async (target: RequestedReviewCandidate) => {
      resolverCalls += 1;
      if (options.movedOnCall === resolverCalls) {
        return resolution({ ...target, headSha: '9'.repeat(40) });
      }
      return resolution(target);
    }),
    resolveCurrent: vi.fn(async () => resolution(options.movedCurrent ? { ...candidate, headSha: '9'.repeat(40) } : candidate)),
  };
  const storage = memoryRepository(now);
  const client = clientFixture();
  const publisher = new OperatorMaintenancePublisher({
    enabled: true, expectedAppIdFor: () => APP_ID, repositoryIds: [REPOSITORY_ID],
    resolver, repository: storage.repo,
    clientFor: async () => client,
    ...(options.verifyMergeGroupCurrent ? { verifyMergeGroupCurrent: options.verifyMergeGroupCurrent } : {}),
    now, leaseMs: 1_000,
  });
  return {
    publisher, resolver, storage, client,
    advance(milliseconds: number) { currentTime += milliseconds; },
  };
}

describe('operator maintenance publisher', () => {
  it('publishes a durable raw SHIP and distinct paired Gate with explicit provenance markers', async () => {
    const f = setup();
    const result = await f.publisher.request({ source: 'central-action-dispatch', candidate });
    expect(result.status).toBe('published');
    expect(result.receipt.reviewCompleted).toBe(false);
    expect(result.receipt.decision).toBe('SHIP');
    expect(result.receipt.intentId).toMatch(/^operator-maintenance:v1:[a-f0-9]{64}$/u);
    const digest = result.receipt.intentId.slice('operator-maintenance:v1:'.length);
    expect(result.receipt.checks.raw.externalId).toBe(`review-yeti-maintenance:v1:${digest}:raw`);
    expect(result.receipt.checks.gate.externalId).toBe(`review-yeti-maintenance:v1:${digest}:gate`);
    const [raw, gate] = [...f.client.checks.values()];
    expect(raw.name).toBe('Review Yeti');
    expect(gate.name).toBe('Review Yeti Gate');
    for (const check of [raw, gate]) {
      expect(check.state).toBe('completed');
      expect(check.summary).toContain('review-mode=passthrough');
      expect(check.summary).toContain('review-completed=false');
      expect(check.summary).toContain('decision=SHIP');
      expect(check.summary).toContain(`intent-id=${result.receipt.intentId}`);
      expect(check.summary).toContain(`effective-policy-digest=${'e'.repeat(64)}`);
    }
    expect(raw.summary).toContain('check-kind=raw');
    expect(gate.summary).toContain('check-kind=gate');
    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
  });

  it.each(['raw', 'gate'] as const)('reconciles an exact %s check left in progress by a lost POST acknowledgement', async (stage) => {
    const f = setup();
    f.client.loseAcknowledgement(stage);
    await expect(f.publisher.request({ source: 'github-app-webhook', candidate })).rejects.toThrow('simulated lost create acknowledgement');
    f.advance(1_001);
    const retry = await f.publisher.request({ source: 'github-app-webhook', candidate });
    expect(retry.status).toBe('published');
    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
    expect(f.client.completions[stage]).toBe(1);
    expect([...f.client.checks.values()].every((check) => check.state === 'completed')).toBe(true);
  });

  it.each(['raw', 'gate'] as const)('the bounded service sweep recovers an expired %s lease without another ingress event', async (stage) => {
    const f = setup();
    f.client.loseAcknowledgement(stage);
    await expect(f.publisher.request({ source: 'github-app-webhook', candidate }))
      .rejects.toThrow('simulated lost create acknowledgement');
    f.advance(1_001);

    await f.publisher.runOnce();

    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
    expect(f.client.completions[stage]).toBe(1);
    expect(f.storage.state.published).toBe(true);
  });

  it('does not publish a paired Gate when the live PR head moves after raw publication', async () => {
    const f = setup({ movedOnCall: 4 });
    await expect(f.publisher.request({ source: 'mcp-trigger', candidate })).rejects.toThrow();
    expect(f.client.posts).toEqual({ raw: 1, gate: 0 });
    expect(f.storage.state.stale).toBe(true);
  });

  it('marks a pending PR intent stale when timer re-resolution observes a moved head', async () => {
    const f = setup({ movedCurrent: true });
    f.client.loseAcknowledgement('gate');
    await expect(f.publisher.request({ source: 'github-app-webhook', candidate }))
      .rejects.toThrow('simulated lost create acknowledgement');
    f.advance(1_001);

    await f.publisher.runOnce();

    expect(f.storage.state.stale).toBe(true);
    expect(f.client.completions.gate).toBe(0);
    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
  });

  it('automatically recovers an expired merge-group Gate lease with its durable policy PR after a raw/Gate crash', async () => {
    const verifyMergeGroupCurrent = vi.fn(async () => undefined);
    const f = setup({ verifyMergeGroupCurrent });
    const { prNumber: _prNumber, ...repositoryIdentity } = candidate;
    const identity = { ...repositoryIdentity, headSha: 'e'.repeat(40), baseSha: 'f'.repeat(40),
      subject: { kind: 'merge_group' as const, headRef: 'refs/heads/gh-readonly-queue/main/pr-27-abcdef0',
        baseRef: 'refs/heads/main' } };
    const policyPullRequest = { repositoryId: REPOSITORY_ID, owner: 'review-yeti-ai', repo: 'sample',
      prNumber: candidate.prNumber, headSha: candidate.headSha };
    f.client.loseAcknowledgement('gate');
    await expect(f.publisher.request({ source: 'github-app-webhook', mergeGroup: {
      identity, policyPullRequest, verifyCurrent: async () => undefined,
    } })).rejects.toThrow('simulated lost create acknowledgement');
    expect(f.storage.state.receipt?.policyResolution).toEqual({ ...policyPullRequest, baseSha: BASE });
    f.advance(1_001);

    await f.publisher.runOnce();

    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
    expect(f.client.completions.gate).toBe(1);
    expect(verifyMergeGroupCurrent).toHaveBeenCalled();
    expect(f.storage.state.published).toBe(true);
  });

  it('marks a pending merge-group intent stale when the current authenticated queue no longer matches', async () => {
    let moved = false;
    const verifyMergeGroupCurrent = vi.fn(async () => {
      if (moved) throw new OperatorMaintenanceTargetChangedError();
    });
    const f = setup({ verifyMergeGroupCurrent });
    const { prNumber: _prNumber, ...repositoryIdentity } = candidate;
    const identity = { ...repositoryIdentity, headSha: 'e'.repeat(40), baseSha: 'f'.repeat(40),
      subject: { kind: 'merge_group' as const, headRef: 'refs/heads/gh-readonly-queue/main/pr-27-abcdef0',
        baseRef: 'refs/heads/main' } };
    const policyPullRequest = { repositoryId: REPOSITORY_ID, owner: 'review-yeti-ai', repo: 'sample',
      prNumber: candidate.prNumber, headSha: candidate.headSha };
    f.client.loseAcknowledgement('gate');
    await expect(f.publisher.request({ source: 'github-app-webhook', mergeGroup: {
      identity, policyPullRequest, verifyCurrent: async () => undefined,
    } })).rejects.toThrow('simulated lost create acknowledgement');
    moved = true;
    f.advance(1_001);

    await f.publisher.runOnce();

    expect(f.storage.state.stale).toBe(true);
    expect(f.client.completions.gate).toBe(0);
    expect(f.client.posts).toEqual({ raw: 1, gate: 1 });
  });
});
