import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewJobDispatchEngine } from '../../src/k8s/reviewJobDispatchEngine';
import type { ReviewDispatchClaim } from '../../src/review/reviewRun';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const receivedAt = Date.parse('2026-08-30T20:00:00.000Z');
const now = receivedAt + 60_000;
const claim = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  claimAttempt: 7,
  executionAttempt: 1,
  repositoryId: 123,
  installationId: 456,
  publicationMode: 'disabled' as const,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt,
  terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  workerTokenDigest: undefined,
  leaseOwner: 'dispatcher-a',
  leaseExpiresAt: now + 30_000,
};

function fixture(overrides: Record<string, any> = {}) {
  const repository = {
    claimNext: vi.fn(async () => claim),
    markProjected: vi.fn(async () => true),
    bindWorkerTokenDigest: vi.fn(async () => true),
    releaseForRetry: vi.fn(async () => true),
    markTerminal: vi.fn(async () => true),
    ...overrides.repository,
  };
  const projector = { ensure: vi.fn(async () => undefined), ...overrides.projector };
  const runSecretProvisioner = overrides.runSecretProvisioner === null
    ? undefined
    : { provision: vi.fn(async () => ({ workerTokenDigest: 'f'.repeat(64) })), ...overrides.runSecretProvisioner };
  const engine = new ReviewJobDispatchEngine({
    repository,
    projector,
    runSecretProvisioner,
    preparedReviewFor: overrides.preparedReviewFor,
    workerId: 'dispatcher-a',
    workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'e'.repeat(64)}`,
    namespace: 'ct-review-qualification',
    now: overrides.now || (() => now),
    leaseMs: 30_000,
    retryDelayMs: 5_000,
  });
  return { engine, repository, projector, runSecretProvisioner };
}

describe('ReviewJobDispatchEngine', () => {
  it('claims one row, builds the fail-closed contract, and records the deterministic projection', async () => {
    const { engine, repository, projector } = fixture();
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'projected',
      runId: claim.runId,
      projectionName: `ct-review-${'1'.repeat(32)}`,
    });
    expect(repository.claimNext).toHaveBeenCalledWith('dispatcher-a', now, 30_000);
    expect(projector.ensure).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ name: `ct-review-${'1'.repeat(32)}` }),
      spec: expect.objectContaining({
        runId: claim.runId,
        executionAttempt: 1,
        publicationMode: 'disabled',
        workerImage: expect.stringMatching(/@sha256:[a-f0-9]{64}$/u),
      }),
    }));
    expect(repository.markProjected).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      `ct-review-${'1'.repeat(32)}`,
      now,
    );
  });

  it('projects an app-gate claim instead of terminating it', async () => {
    const { engine, projector, repository, runSecretProvisioner } = fixture({
      repository: { claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })) },
    });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'projected',
      runId: claim.runId,
      projectionName: `ct-review-${'1'.repeat(32)}`,
    });
    expect(projector.ensure).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ publicationMode: 'app-gate' }),
    }));
    expect(repository.markTerminal).not.toHaveBeenCalled();
    // The credential must be in place before the Job exists, not after.
    expect(runSecretProvisioner?.provision).toHaveBeenCalledWith(expect.objectContaining({
      runId: claim.runId,
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
    }));
    expect((runSecretProvisioner!.provision as any).mock.invocationCallOrder[0])
      .toBeLessThan((projector.ensure as any).mock.invocationCallOrder[0]);
    expect(repository.bindWorkerTokenDigest).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      'f'.repeat(64),
      now,
    );
    expect(repository.markProjected).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      `ct-review-${'1'.repeat(32)}`,
      now,
      'f'.repeat(64),
    );
  });

  it('reuses a durable token digest after a projector retry without provisioning again', async () => {
    const provision = vi.fn(async () => ({ workerTokenDigest: 'f'.repeat(64) }));
    const { engine, repository } = fixture({
      repository: {
        claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const, workerTokenDigest: 'a'.repeat(64) })),
      },
      runSecretProvisioner: { provision },
    });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'projected',
      runId: claim.runId,
      projectionName: `ct-review-${'1'.repeat(32)}`,
    });
    expect(provision).not.toHaveBeenCalled();
    expect(repository.bindWorkerTokenDigest).not.toHaveBeenCalled();
    expect(repository.markProjected).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      `ct-review-${'1'.repeat(32)}`,
      now,
      'a'.repeat(64),
    );
  });

  it('does not project when the durable token bind loses the lease', async () => {
    const { engine, projector, repository } = fixture({
      repository: {
        claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })),
        bindWorkerTokenDigest: vi.fn(async () => false),
      },
    });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
    expect(projector.ensure).not.toHaveBeenCalled();
    expect(repository.markProjected).not.toHaveBeenCalled();
  });

  it('never provisions a run secret for a non-publishing claim', async () => {
    // A receipt-only worker makes no GitHub call, so minting it a token would be
    // an unnecessary credential with no consumer.
    const { engine, runSecretProvisioner } = fixture();
    await engine.runOnce();
    expect(runSecretProvisioner?.provision).not.toHaveBeenCalled();
  });

  it('terminates an app-gate claim when no provisioner is configured', async () => {
    // Fail closed. Projecting without the Secret would start a worker that cannot
    // publish, and the fail-closed lane turns that into a failed check on the pull
    // request rather than a dispatch error anyone would look at.
    const { engine, projector, repository } = fixture({
      repository: { claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })) },
      runSecretProvisioner: null,
    });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'terminal',
      runId: claim.runId,
      reason: 'run-secret-unavailable',
    });
    expect(projector.ensure).not.toHaveBeenCalled();
  });

  it('retries rather than terminates when the token mint fails', async () => {
    // Minting is a network call and GitHub rate limits are transient; the terminal
    // deadline still bounds how long this can go on.
    const { engine, projector, repository } = fixture({
      repository: { claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })) },
      runSecretProvisioner: { provision: vi.fn(async () => { throw new Error('429 rate limit'); }) },
    });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'retry',
      runId: claim.runId,
      availableAt: now + 5_000,
      reason: 'run-secret-provisioning',
    });
    expect(projector.ensure).not.toHaveBeenCalled();
    expect(repository.markTerminal).not.toHaveBeenCalled();
  });

  it('terminates a too-late claim without calling the projector', async () => {
    const rejected = { ...claim, terminalDeadline: now + 119_999 };
    const { engine, repository, projector } = fixture({
      repository: { claimNext: vi.fn(async () => rejected) },
    });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'terminal',
      runId: claim.runId,
      reason: 'projection-rejected',
    });
    expect(projector.ensure).not.toHaveBeenCalled();
    expect(repository.markTerminal).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      now,
      'review job projection rejected',
      { reason: 'review_job_projection_rejected', logTail: 'review job projection rejected' },
    );
  });

  it('releases transient projector failures for a bounded durable retry without returning error text', async () => {
    const { engine, repository } = fixture({
      projector: { ensure: vi.fn(async () => { throw new Error('secret-bearing upstream failure'); }) },
    });
    const outcome = await engine.runOnce();
    // The stage is reported, the upstream text is not: naming which step failed is
    // what makes a retry loop diagnosable, and it costs nothing in disclosure.
    expect(outcome).toEqual({ status: 'retry', runId: claim.runId, availableAt: now + 5_000, reason: 'projection' });
    expect(JSON.stringify(outcome)).not.toContain('secret-bearing');
    expect(repository.releaseForRetry).toHaveBeenCalledWith(claim.runId, 'dispatcher-a', claim.claimAttempt, now, now + 5_000);
  });

  it('reports lease loss instead of acknowledging a projection it could not persist', async () => {
    const { engine } = fixture({ repository: { markProjected: vi.fn(async () => false) } });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
  });

  it.each(['bind', 'project'] as const)('uses the current clock when a delayed %s reaches lease expiry', async (stage) => {
    let clock = now;
    const acknowledge = vi.fn(async (_runId: string, _owner: string, attempt: number, _payload: string, mutationNow: number) =>
      attempt === claim.claimAttempt && mutationNow < claim.leaseExpiresAt);
    const { engine, projector } = fixture({
      now: () => clock,
      repository: stage === 'bind'
        ? {
          claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })),
          bindWorkerTokenDigest: acknowledge,
        }
        : { markProjected: acknowledge },
      runSecretProvisioner: { provision: vi.fn(async () => {
        clock = claim.leaseExpiresAt;
        return { workerTokenDigest: 'f'.repeat(64) };
      }) },
      projector: { ensure: vi.fn(async () => { clock = claim.leaseExpiresAt; }) },
    });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
    expect(acknowledge.mock.calls[0][2]).toBe(claim.claimAttempt);
    expect(acknowledge.mock.calls[0][4]).toBe(claim.leaseExpiresAt);
    if (stage === 'bind') expect(projector.ensure).not.toHaveBeenCalled();
  });

  it.each([
    { stage: 'run-secret-provisioning', delay: 10_000 },
    { stage: 'run-secret-provisioning', delay: 30_000 },
    { stage: 'projection', delay: 10_000 },
    { stage: 'projection', delay: 30_000 },
  ])('fences a $stage retry after a $delay ms delay using a fresh timestamp', async ({ stage, delay }) => {
    let clock = now;
    const delayedFailure = vi.fn(async () => {
      clock += delay;
      throw new Error('transient upstream failure');
    });
    const release = vi.fn(async (_runId: string, _owner: string, attempt: number, mutationNow: number) =>
      attempt === claim.claimAttempt && mutationNow < claim.leaseExpiresAt);
    const { engine } = fixture({
      now: () => clock,
      repository: {
        claimNext: vi.fn(async () => ({ ...claim, publicationMode: 'app-gate' as const })),
        releaseForRetry: release,
      },
      ...(stage === 'run-secret-provisioning'
        ? { runSecretProvisioner: { provision: delayedFailure } }
        : { projector: { ensure: delayedFailure } }),
    });
    await expect(engine.runOnce()).resolves.toEqual(delay < 30_000
      ? { status: 'retry', runId: claim.runId, availableAt: now + delay + 5_000, reason: stage }
      : { status: 'lease-lost', runId: claim.runId });
    expect(release).toHaveBeenCalledWith(claim.runId, claim.leaseOwner, claim.claimAttempt, now + delay, now + delay + 5_000);
  });

  it.each(['projection-rejected', 'run-secret-unavailable'] as const)('passes the claim fence and current time when marking %s', async (reason) => {
    let clock = now;
    const { engine, repository } = fixture({
      now: () => clock,
      repository: { claimNext: vi.fn(async () => {
        clock += 1_000;
        return reason === 'projection-rejected'
          ? { ...claim, terminalDeadline: now + 119_999 }
          : { ...claim, publicationMode: 'app-gate' as const };
      }) },
      runSecretProvisioner: null,
    });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'terminal', runId: claim.runId, reason });
    expect(repository.markTerminal).toHaveBeenCalledWith(
      claim.runId, claim.leaseOwner, claim.claimAttempt, now + 1_000,
      reason === 'projection-rejected'
        ? 'review job projection rejected'
        : 'publishing review dispatched without a run secret provisioner',
      reason === 'projection-rejected'
        ? { reason: 'review_job_projection_rejected', logTail: 'review job projection rejected' }
        : { reason: 'run_secret_provisioner_unavailable', logTail: 'run secret provisioner unavailable' },
    );
  });

  it('reports lease loss when terminal or retry acknowledgement loses ownership', async () => {
    const terminal = fixture({
      repository: {
        claimNext: vi.fn(async () => ({ ...claim, terminalDeadline: now + 119_999 })),
        markTerminal: vi.fn(async () => false),
      },
    });
    await expect(terminal.engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });

    const retry = fixture({
      repository: { releaseForRetry: vi.fn(async () => false) },
      projector: { ensure: vi.fn(async () => { throw new Error('transient'); }) },
    });
    await expect(retry.engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
  });

  it('uses a fresh execution identity after a worker retry while keeping the run identity stable', async () => {
    const { engine, projector, repository } = fixture({
      repository: { claimNext: vi.fn(async () => ({ ...claim, executionAttempt: 2 })) },
    });

    await expect(engine.runOnce()).resolves.toEqual({
      status: 'projected',
      runId: claim.runId,
      projectionName: `ct-review-${'1'.repeat(32)}-a2`,
    });
    expect(projector.ensure).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ name: `ct-review-${'1'.repeat(32)}-a2` }),
      spec: expect.objectContaining({
        runId: claim.runId,
        executionAttempt: 2,
        runSecretName: `ct-review-run-${'1'.repeat(32)}-a2`,
      }),
    }));
    expect(repository.markProjected).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
      claim.claimAttempt,
      `ct-review-${'1'.repeat(32)}-a2`,
      now,
    );
  });

  it('is idle when no durable row is available', async () => {
    const { engine, projector } = fixture({ repository: { claimNext: vi.fn(async () => null) } });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'idle' });
    expect(projector.ensure).not.toHaveBeenCalled();
  });
});

describe('ReviewJobDispatchEngine authoritative prepared-policy lookup', () => {
  afterEach(() => { vi.useRealTimers(); });

  function authoritativeFixture(overrides: Record<string, any> = {}) {
    const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 1 },
    } });
    const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'admitted-review-model' };
    const prepared = preparePublishingPolicy({ content, source: {
      repositoryId: 987, repository: 'central/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
      contentDigest: createHash('sha256').update(content).digest('hex'),
    } }, transport);
    const envelope = { version: 'PreparedReviewExecution.v1', config: prepared.config, transport };
    const serialized = JSON.stringify(envelope);
    const authoritativeClaim: ReviewDispatchClaim = { ...claim, publicationMode: 'app-gate',
      authoritativeGateAppId: 4385771, policyDigest: prepared.policy.effectivePolicyDigest,
      configDigest: prepared.policy.effectiveConfigDigest };
    const preparedReviewFor = vi.fn<(claim: ReviewDispatchClaim) => Promise<string>>().mockResolvedValue(serialized);
    const f = fixture({ preparedReviewFor, ...overrides, repository: {
      claimNext: vi.fn(async () => authoritativeClaim), ...overrides.repository,
    } });
    return { ...f, authoritativeClaim, preparedReviewFor, prepared, envelope, serialized };
  }

  function expectNoProjectionEffects(f: ReturnType<typeof authoritativeFixture>) {
    expect(f.runSecretProvisioner?.provision).not.toHaveBeenCalled();
    expect(f.repository.bindWorkerTokenDigest).not.toHaveBeenCalled();
    expect(f.projector.ensure).not.toHaveBeenCalled();
    expect(f.repository.markProjected).not.toHaveBeenCalled();
    expect(f.repository.releaseForRetry).not.toHaveBeenCalled();
  }

  async function expectRejectedProjection(f: ReturnType<typeof authoritativeFixture>, at = now) {
    await expect(f.engine.runOnce()).resolves.toEqual({ status: 'terminal', runId: claim.runId, reason: 'projection-rejected' });
    expect(f.repository.markTerminal).toHaveBeenCalledExactlyOnceWith(
      claim.runId, claim.leaseOwner, claim.claimAttempt, at, 'review job projection rejected',
      { reason: 'review_job_projection_rejected', logTail: 'review job projection rejected' },
    );
    expectNoProjectionEffects(f);
  }

  it('looks up the exact claim before provisioning and forwards only the validated envelope unchanged', async () => {
    vi.stubEnv('REVIEW_MODEL', 'mutable-model');
    vi.stubEnv('REVIEW_PERSONAS', 'licensing');
    const f = authoritativeFixture();
    await expect(f.engine.runOnce()).resolves.toMatchObject({ status: 'projected', runId: claim.runId });
    expect(f.preparedReviewFor).toHaveBeenCalledExactlyOnceWith(f.authoritativeClaim);
    expect(f.projector.ensure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      spec: expect.objectContaining({ preparedReview: f.serialized,
        configDigest: f.prepared.policy.effectiveConfigDigest, policyDigest: f.prepared.policy.effectivePolicyDigest,
        publicationMode: 'app-gate', workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'e'.repeat(64)}` }),
    }));
    expect(f.preparedReviewFor.mock.invocationCallOrder[0]).toBeLessThan(f.runSecretProvisioner!.provision.mock.invocationCallOrder[0]);
    expect(f.runSecretProvisioner!.provision.mock.invocationCallOrder[0]).toBeLessThan(f.repository.bindWorkerTokenDigest.mock.invocationCallOrder[0]);
    expect(f.repository.bindWorkerTokenDigest.mock.invocationCallOrder[0]).toBeLessThan(f.projector.ensure.mock.invocationCallOrder[0]);
    expect(f.repository.markTerminal).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative callback is absent instead of falling back to legacy publishing', async () => {
    await expectRejectedProjection(authoritativeFixture({ preparedReviewFor: undefined }));
  });

  it.each(['empty', 'undefined', 'null', 'invalid JSON', 'wrong version', 'extra authority',
    'wrong config', 'wrong transport', 'oversize'] as const)('rejects a %s envelope before any Secret or Job effect', async (invalid) => {
    const f = authoritativeFixture();
    const values: Record<typeof invalid, unknown> = {
      empty: '', undefined, null: null, 'invalid JSON': '{private policy content',
      'wrong version': JSON.stringify({ ...f.envelope, version: 'PreparedReviewExecution.v2' }),
      'extra authority': JSON.stringify({ ...f.envelope, checkId: 4242 }),
      'wrong config': JSON.stringify({ ...f.envelope, config: { ...f.envelope.config, default_max_turns: 2 } }),
      'wrong transport': JSON.stringify({ ...f.envelope, transport: { ...f.envelope.transport, model: 'different-model' } }),
      oversize: `${f.serialized}${' '.repeat(256 * 1024)}`,
    };
    // Exercise corrupt/missing persistence returns at the runtime boundary.
    f.preparedReviewFor.mockResolvedValue(values[invalid] as string);
    await expectRejectedProjection(f);
  });

  it.each(['rejection', 'synchronous throw'] as const)('redacts a lookup %s and does not provision or retry', async (failure) => {
    const f = authoritativeFixture();
    const privateDetail = 'ghs_private_token private policy transcript';
    if (failure === 'rejection') f.preparedReviewFor.mockRejectedValue(new Error(privateDetail));
    else f.preparedReviewFor.mockImplementation(() => { throw new Error(privateDetail); });
    await expectRejectedProjection(f);
    expect(JSON.stringify(f.repository.markTerminal.mock.calls)).not.toContain(privateDetail);
  });

  it('rejects a valid envelope when it is not the config admitted by the claim', async () => {
    const f = authoritativeFixture();
    f.authoritativeClaim.configDigest = '0'.repeat(64);
    await expectRejectedProjection(f);
  });

  it('reports lease loss when marking a failed lookup no longer owns the claim', async () => {
    const f = authoritativeFixture({ repository: { markTerminal: vi.fn(async () => false) } });
    f.preparedReviewFor.mockRejectedValue(new Error('lookup unavailable'));
    await expect(f.engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
    expectNoProjectionEffects(f);
  });

  it('bounds a hung read at exactly five seconds; a late success cannot provision or publish a Job', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = authoritativeFixture({ now: Date.now });
    const deferred = Promise.withResolvers<string>();
    f.preparedReviewFor.mockReturnValue(deferred.promise);
    const pending = f.engine.runOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.preparedReviewFor).toHaveBeenCalledExactlyOnceWith(f.authoritativeClaim);
    expectNoProjectionEffects(f);
    expect(f.repository.markTerminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: 'terminal', runId: claim.runId, reason: 'projection-rejected' });
    expect(f.repository.markTerminal).toHaveBeenCalledExactlyOnceWith(
      claim.runId, claim.leaseOwner, claim.claimAttempt, now + 5_000, 'review job projection rejected',
      { reason: 'review_job_projection_rejected', logTail: 'review job projection rejected' },
    );
    expect(vi.getTimerCount()).toBe(0);
    deferred.resolve(f.serialized);
    await vi.advanceTimersByTimeAsync(30_000);
    expectNoProjectionEffects(f);
    expect(f.repository.markTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'rejection'] as const)('clears the bounded lookup timer after early %s', async (outcome) => {
    vi.useFakeTimers();
    const f = authoritativeFixture();
    const deferred = Promise.withResolvers<string>();
    f.preparedReviewFor.mockReturnValue(deferred.promise);
    const pending = f.engine.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);
    expectNoProjectionEffects(f);
    if (outcome === 'success') deferred.resolve(f.serialized);
    else deferred.reject(new Error('lookup failed'));
    await expect(pending).resolves.toMatchObject({ status: outcome === 'success' ? 'projected' : 'terminal' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.repository.markTerminal).toHaveBeenCalledTimes(outcome === 'success' ? 0 : 1);
    expect(f.projector.ensure).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
  });

  it.each(['disabled', 'app-gate'] as const)('ignores the prepared-policy callback entirely for legacy %s claims', async (publicationMode) => {
    const lookup = vi.fn(async () => { throw new Error('Legacy must not look up an authoritative policy'); });
    const f = fixture({ preparedReviewFor: lookup,
      repository: { claimNext: vi.fn(async () => ({ ...claim, publicationMode })) } });
    await expect(f.engine.runOnce()).resolves.toMatchObject({ status: 'projected', runId: claim.runId });
    expect(lookup).not.toHaveBeenCalled();
    expect(f.projector.ensure.mock.calls[0][0].spec).not.toHaveProperty('preparedReview');
    expect(f.repository.markTerminal).not.toHaveBeenCalled();
  });
});
