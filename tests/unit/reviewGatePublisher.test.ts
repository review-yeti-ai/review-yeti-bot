import { describe, expect, it, vi } from 'vitest';
import { ReviewGatePublisher } from '../../src/review/reviewGatePublisher';
import { deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME, type ReviewGateCheck } from '../../src/github/reviewGateClient';
import type { GatePublicationClaim } from '../../src/persistence/reviewGateRepository';

const coordinates = { owner: 'example', repo: 'repo', repositoryId: 123, prNumber: 42,
  runId: `run_${'a'.repeat(32)}`, executionAttempt: 1, attemptId: 'attempt-g0-e1',
  headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyDigest: 'd'.repeat(64) };
const claim: GatePublicationClaim = {
  coordinates, reviewGeneration: 0, expectedAppId: 4385771, externalId: deriveReviewGateExternalId(coordinates),
  checkId: null, creationState: 'creating', desiredState: 'queued', desiredVersion: 0,
  publishedVersion: -1, current: true, leaseOwner: 'test-publisher', leaseToken: '00000000-0000-4000-8000-000000000001', mayCreate: true,
};
const check: ReviewGateCheck = { id: 1234, name: REVIEW_GATE_CHECK_NAME, appId: 4385771,
  headSha: coordinates.headSha, externalId: claim.externalId, status: 'queued' as const, conclusion: null };
function fixture(overrides: Partial<GatePublicationClaim> = {}) {
  const active = { ...claim, ...overrides };
  const notStarted = vi.fn();
  const repository = {
    claimPublication: vi.fn(async () => active as GatePublicationClaim | null),
    publishLocked: vi.fn(async (_claim, publish): Promise<'published' | 'stale-claim' | 'retry'> => {
      const result = await publish(active, active.mayCreate);
      if (result.kind === 'not-started') { notStarted(result); return 'retry'; }
      return 'published';
    }),
    retryPublication: vi.fn(async () => true),
  };
  const client = {
    createPending: vi.fn(async () => check), reconcile: vi.fn(async () => check as typeof check | null),
    updateExisting: vi.fn(async () => check),
  };
  const clientFor = vi.fn(async () => client);
  const publisher = new ReviewGatePublisher({ repository, clientFor, workerId: 'test-publisher', now: () => 1_000 });
  return { repository, client, clientFor, notStarted, publisher };
}

describe('durable service gate publisher', () => {
  it('does no work without a durable publication claim', async () => {
    const f = fixture();
    f.repository.claimPublication.mockResolvedValue(null);
    expect(await f.publisher.runOnce()).toEqual({ status: 'idle' });
    expect(f.repository.publishLocked).not.toHaveBeenCalled();
  });
  it('creates only with the committed first creation claim', async () => {
    const f = fixture();
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
    expect(f.client.createPending).toHaveBeenCalledOnce();
    expect(f.client.reconcile).not.toHaveBeenCalled();
    expect(f.client.updateExisting).toHaveBeenCalledWith({ coordinates, checkId: 1234, update: { status: 'queued' } });
  });
  it('preserves a lost create acknowledgement and never retries POST', async () => {
    const f = fixture();
    f.client.createPending.mockRejectedValue(new Error('synthetic private transport detail'));
    expect(await f.publisher.runOnce()).toEqual({ status: 'retry', attemptId: coordinates.attemptId });
    expect(f.client.createPending).toHaveBeenCalledOnce();
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'unknown-create');
    expect(f.notStarted).not.toHaveBeenCalled();
  });
  it.each(['rejection', 'synchronous throw'] as const)('recovers a first-claim factory %s inside the locked publication', async (failure) => {
    const f = fixture();
    const detail = 'ghs_private_factory_token';
    if (failure === 'rejection') f.clientFor.mockRejectedValue(new Error(detail));
    else f.clientFor.mockImplementation(() => { throw new Error(detail); });
    expect(await f.publisher.runOnce()).toEqual({ status: 'retry', attemptId: coordinates.attemptId });
    expect(f.notStarted).toHaveBeenCalledExactlyOnceWith({ kind: 'not-started', retryDelayMs: 30_000 });
    expect(f.repository.retryPublication).not.toHaveBeenCalled();
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.reconcile).not.toHaveBeenCalled();
    expect(f.client.updateExisting).not.toHaveBeenCalled();
  });
  it.each([
    { mayCreate: false },
    { mayCreate: false, checkId: 1234, creationState: 'bound' as const },
  ])('never rearms factory failure on an uncertain or bound intent: %j', async (overrides) => {
    const f = fixture(overrides);
    f.clientFor.mockRejectedValue(new Error('factory unavailable'));
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
    expect(f.notStarted).not.toHaveBeenCalled();
    expect(f.repository.retryPublication).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1_000, 30_000,
      overrides.checkId ? 'transport' : 'unknown-create');
    expect(f.client.createPending).not.toHaveBeenCalled();
  });
  it('never rearms after createPending is invoked, even if it throws a not-started-shaped value synchronously', async () => {
    const f = fixture();
    f.client.createPending.mockImplementation(() => { throw { kind: 'not-started', retryDelayMs: 30_000 }; });
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
    expect(f.client.createPending).toHaveBeenCalledOnce();
    expect(f.notStarted).not.toHaveBeenCalled();
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'unknown-create');
  });
  it('does not rearm when update fails after a successfully returned create', async () => {
    const f = fixture();
    f.client.updateExisting.mockRejectedValue(new Error('PATCH timeout after accepted POST'));
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
    expect(f.client.createPending).toHaveBeenCalledOnce();
    expect(f.notStarted).not.toHaveBeenCalled();
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'unknown-create');
  });
  it('reconciles the same attempt after an uncertain create; empty reads never authorize another create', async () => {
    const f = fixture({ mayCreate: false });
    f.client.reconcile.mockResolvedValue(null);
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.updateExisting).not.toHaveBeenCalled();
  });
  it('uses only the persisted check ID for terminal publication', async () => {
    const f = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure' });
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.reconcile).not.toHaveBeenCalled();
    expect(f.client.updateExisting).toHaveBeenCalledWith({ coordinates, checkId: 1234, update: { conclusion: 'failure' } });
  });
  it('records a bound-check transport failure without creating or reconciling another check', async () => {
    const f = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'success' });
    f.client.updateExisting.mockRejectedValue(new Error('synthetic private transport detail'));
    expect(await f.publisher.runOnce()).toEqual({ status: 'retry', attemptId: coordinates.attemptId });
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.objectContaining({ checkId: 1234 }),
      1_000, 30_000, 'transport');
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.reconcile).not.toHaveBeenCalled();
    expect(f.client.updateExisting).toHaveBeenCalledOnce();
  });
  it('releases a stale publication claim through the fenced retry path', async () => {
    const f = fixture();
    f.repository.publishLocked.mockResolvedValue('stale-claim');
    expect(await f.publisher.runOnce()).toEqual({ status: 'stale-claim', attemptId: coordinates.attemptId });
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'stale-claim');
    expect(f.client.createPending).not.toHaveBeenCalled();
  });
  it('bounds an uncooperative client factory and cannot publish when it resolves late', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let ready!: (client: typeof f.client) => void;
      const publisher = new ReviewGatePublisher({ repository: f.repository, workerId: 'test-publisher', now: () => 1_000,
        clientFactoryTimeoutMs: 250, clientFor: () => new Promise((resolve) => { ready = resolve; }) });
      const outcome = publisher.runOnce();
      await vi.advanceTimersByTimeAsync(250);
      expect(await outcome).toMatchObject({ status: 'retry' });
      expect(f.notStarted).toHaveBeenCalledExactlyOnceWith({ kind: 'not-started', retryDelayMs: 30_000 });
      expect(f.repository.retryPublication).not.toHaveBeenCalled();
      ready(f.client);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.client.createPending).not.toHaveBeenCalled();
      expect(f.client.updateExisting).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([0, 249, 45_001, 250.5, Infinity])('rejects an unbounded client deadline %s', (clientFactoryTimeoutMs) => {
    const f = fixture();
    expect(() => new ReviewGatePublisher({ repository: f.repository, workerId: 'test-publisher',
      clientFor: async () => f.client, clientFactoryTimeoutMs })).toThrow('bounded');
  });
});
