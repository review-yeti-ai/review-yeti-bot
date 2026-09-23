import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from '../../src/review/reviewGatePublisher';
import { deriveReviewGateExternalId, GitHubReviewGateClient, REVIEW_GATE_CHECK_NAME,
  type ReviewGateCheck } from '../../src/github/reviewGateClient';
import type { GatePublicationClaim, ReviewGateRepository } from '../../src/review/reviewGateContracts';

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
    claimPublication: vi.fn<ReviewGateRepository['claimPublication']>(async () => active),
    publishLocked: vi.fn<ReviewGateRepository['publishLocked']>(async (_claim, publish) => {
      const result = await publish(active, active.mayCreate);
      if ('kind' in result && result.kind === 'not-started') { notStarted(result); return 'retry'; }
      return 'published';
    }),
    retryPublication: vi.fn<ReviewGateRepository['retryPublication']>(async () => true),
  } satisfies ReviewGateRepository;
  const client = {
    createPending: vi.fn(async () => check), reconcile: vi.fn(async () => check as typeof check | null),
    updateExisting: vi.fn(async () => check),
  };
  const clientFor = vi.fn<ReviewGatePublisherOptions['clientFor']>(async () => client);
  const publisher = new ReviewGatePublisher({ repository, clientFor, workerId: 'test-publisher', now: () => 1_000 });
  return { repository, client, clientFor, notStarted, publisher };
}

/** The update the publisher handed the client, typed from the mock's own
 * signature. Indexing `mock.calls[0][0]` directly trips
 * noUncheckedIndexedAccess and empty-tuple inference, so this narrows once and
 * fails loudly if the publisher never called updateExisting. */
function publishedUpdate(client: {
  updateExisting: { mock: { calls: unknown[][] } };
}): Record<string, unknown> {
  const call = client.updateExisting.mock.calls[0];
  if (!call) throw new Error('publisher did not call updateExisting');
  return (call[0] as { update: Record<string, unknown> }).update;
}

describe('durable service gate publisher', () => {
  it('depends only on the domain storage port, not a Postgres class or client', () => {
    for (const file of ['reviewGatePublisher.ts', 'reviewGateContracts.ts']) {
      const source = readFileSync(new URL(`../../src/review/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from\s+['"](?:pg|\.\.\/persistence\/[^'"]+)['"]/u);
      expect(source).not.toContain('PostgresReviewGateRepository');
    }
  });

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
  it('publishes terminal success and matching presentation in one GitHub PATCH', async () => {
    const f = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'success' });
    const observed = { id: 1234, name: REVIEW_GATE_CHECK_NAME, app: { id: 4385771 },
      head_sha: coordinates.headSha, external_id: claim.externalId };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...observed, status: 'queued', conclusion: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...observed, status: 'completed', conclusion: 'success' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    f.clientFor.mockResolvedValue(new GitHubReviewGateClient({
      token: 'ghs_test-token', expectedAppId: 4385771, baseUrl: 'https://github.test/api/v3', fetchImplementation,
    }));

    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body))).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      output: {
        title: 'Review Yeti Gate: Approved (SHIP)',
        summary: 'Review Yeti completed this attempt and the policy eligibility gate passed.',
        text: 'Terminal conclusion: success.',
      },
    });
  });

  it('publishes bounded terminal failure output in the same PATCH without metadata', async () => {
    const f = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure' });
    const observed = { id: 1234, name: REVIEW_GATE_CHECK_NAME, app: { id: 4385771 },
      head_sha: coordinates.headSha, external_id: claim.externalId };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...observed, status: 'queued', conclusion: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...observed, status: 'completed', conclusion: 'failure' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    f.clientFor.mockResolvedValue(new GitHubReviewGateClient({
      token: 'ghs_test-token', expectedAppId: 4385771, baseUrl: 'https://github.test/api/v3', fetchImplementation,
    }));

    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchImplementation.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
      output: {
        title: 'Review Yeti Gate: Failed',
        summary: 'Review Yeti completed this attempt but the policy eligibility gate failed.',
        text: 'Terminal conclusion: failure.',
      },
    });
    expect(JSON.stringify(body)).not.toContain('ghs_test-token');
  });


  // REL-1019 criterion 3: the failure summary must name the concrete cause.
  // The generic "policy eligibility gate failed" made a lane skew (a stale run)
  // indistinguishable from a provider outage or a genuinely failed panel, which
  // is exactly the ambiguity REL-1019 was filed against.
  it('names a lane skew in the failure summary instead of a generic message', async () => {
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure',
      decisionReason: 'incomplete-review', expectedLanes: 3, completedLanes: 2,
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update).toMatchObject({
      conclusion: 'failure',
      title: 'Review Yeti Gate: Failed (incomplete panel)',
    });
    // The counts are named so an operator can act without reading the DB.
    expect(update.summary).toContain('expected 3');
    expect(update.summary).toContain('2 completed');
    expect(update.summary).toMatch(/not a findings verdict/i);
  });

  it('names the decision reason for a non-skew failure', async () => {
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure',
      decisionReason: 'infrastructure-failure',
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update).toMatchObject({
      conclusion: 'failure',
      title: 'Review Yeti Gate: Failed',
      summary: 'Review Yeti Gate failed: infrastructure-failure. This is not an approval.',
    });
  });

  it('names the reason for a timed_out conclusion, which is also not an approval', async () => {
    // The Postgres integration suite caught this: the reaper publishes
    // `timed_out` with reason 'review-deadline-exceeded', but the metadata
    // helper originally keyed only on `failure`, so an expired review
    // published no cause at all.
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound',
      desiredState: 'timed_out', decisionReason: 'review-deadline-exceeded',
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update).toMatchObject({
      conclusion: 'timed_out',
      title: 'Review Yeti Gate: Failed',
      summary: 'Review Yeti Gate failed: review-deadline-exceeded. This is not an approval.',
    });
  });

  it('does not name a reason for a cancellation, which is not a review outcome', async () => {
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound',
      desiredState: 'cancelled', decisionReason: 'candidate-superseded',
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update).toMatchObject({ conclusion: 'cancelled' });
    expect(update.title).toBeUndefined();
    expect(update.summary).toBeUndefined();
  });

  it('falls back to the reason-only summary when lane evidence is partial or absent', async () => {
    // The skew sentence requires BOTH counts. A row with only one (evidence
    // absent, or a count failing the safe-integer guard) must not interpolate
    // "undefined" into the published text.
    for (const overrides of [
      { decisionReason: 'incomplete-review', expectedLanes: 3 },
      { decisionReason: 'incomplete-review', completedLanes: 2 },
      { decisionReason: 'incomplete-review' },
    ]) {
      const f = fixture({
        mayCreate: false, checkId: 1234, creationState: 'bound',
        desiredState: 'failure', ...overrides,
      });
      await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

      const update = publishedUpdate(f.client);
      expect(update.title).toBe('Review Yeti Gate: Failed');
      expect(String(update.summary)).not.toMatch(/incomplete panel|undefined|NaN/);
      expect(String(update.summary)).toContain('incomplete-review');
    }
  });

  it('names an incomplete panel when completedLanes is zero', async () => {
    // Zero completed lanes is the flagship REL-1019 case — nobody reviewed this
    // head. A truthiness refactor of the guard (`expectedLanes && completedLanes`)
    // would silently drop it, so the zero must be asserted explicitly.
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure',
      decisionReason: 'incomplete-review', expectedLanes: 5, completedLanes: 0,
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update.title).toBe('Review Yeti Gate: Failed (incomplete panel)');
    expect(String(update.summary)).toContain('expected 5');
    expect(String(update.summary)).toContain('0 completed');
  });

  it('does not claim an incomplete panel for a non-skew reason that carries counts', async () => {
    // The mapping layer decouples counts from the reason (fromRow maps them
    // independently), so a failure can carry both counts and a reason like
    // 'blocking-findings'. Counts alone must not trigger the skew summary.
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure',
      decisionReason: 'blocking-findings', expectedLanes: 5, completedLanes: 5,
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update.title).toBe('Review Yeti Gate: Failed');
    expect(String(update.summary)).toBe(
      'Review Yeti Gate failed: blocking-findings. This is not an approval.',
    );
  });

  it('withholds failure metadata from a success even when a reason was recorded', async () => {
    // Pins the desiredState disjunct: without it, a success row carrying a
    // reason would publish "Review Yeti Gate: Failed" on a passing gate.
    const f = fixture({
      mayCreate: false, checkId: 1234, creationState: 'bound',
      desiredState: 'success', decisionReason: 'clean-review',
      expectedLanes: 3, completedLanes: 3,
    });
    await expect(f.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });

    const update = publishedUpdate(f.client);
    expect(update).toMatchObject({ conclusion: 'success' });
    expect(update.title).toBeUndefined();
    expect(update.summary).toBeUndefined();
  });

  it('does not attach failure metadata to a success, and stays silent without a decision', async () => {
    // A success must keep its own summary.
    const ok = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'success' });
    await expect(ok.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });
    const okUpdate = publishedUpdate(ok.client);
    expect(okUpdate.summary).toBeUndefined();
    expect(okUpdate.title).toBeUndefined();

    // No recorded decision (an older row) must not invent a reason.
    const legacy = fixture({ mayCreate: false, checkId: 1234, creationState: 'bound', desiredState: 'failure' });
    await expect(legacy.publisher.runOnce()).resolves.toMatchObject({ status: 'published' });
    const legacyUpdate = publishedUpdate(legacy.client);
    expect(legacyUpdate.summary).toBeUndefined();
    expect(legacyUpdate.title).toBeUndefined();
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
