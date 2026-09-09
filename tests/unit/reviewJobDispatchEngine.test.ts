import { describe, expect, it, vi } from 'vitest';
import { ReviewJobDispatchEngine } from '../../src/k8s/reviewJobDispatchEngine';

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
  terminalDeadline: receivedAt + 900_000,
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
