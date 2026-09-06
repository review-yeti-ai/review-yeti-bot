import { describe, expect, it, vi } from 'vitest';
import { ReviewJobDispatchEngine } from '../../src/k8s/reviewJobDispatchEngine';

const receivedAt = Date.parse('2026-08-30T20:00:00.000Z');
const now = receivedAt + 60_000;
const claim = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
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
  leaseOwner: 'dispatcher-a',
  leaseExpiresAt: now + 30_000,
};

function fixture(overrides: Record<string, any> = {}) {
  const repository = {
    claimNext: vi.fn(async () => claim),
    markProjected: vi.fn(async () => true),
    releaseForRetry: vi.fn(async () => true),
    markTerminal: vi.fn(async () => true),
    ...overrides.repository,
  };
  const projector = { ensure: vi.fn(async () => undefined), ...overrides.projector };
  const runSecretProvisioner = overrides.runSecretProvisioner === null
    ? undefined
    : { provision: vi.fn(async () => undefined), ...overrides.runSecretProvisioner };
  const engine = new ReviewJobDispatchEngine({
    repository,
    projector,
    runSecretProvisioner,
    workerId: 'dispatcher-a',
    workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'e'.repeat(64)}`,
    namespace: 'ct-review-qualification',
    now: () => now,
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
        publicationMode: 'disabled',
        workerImage: expect.stringMatching(/@sha256:[a-f0-9]{64}$/u),
      }),
    }));
    expect(repository.markProjected).toHaveBeenCalledWith(
      claim.runId,
      'dispatcher-a',
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
      now,
      'review job projection rejected',
    );
  });

  it('releases transient projector failures for a bounded durable retry without returning error text', async () => {
    const { engine, repository } = fixture({
      projector: { ensure: vi.fn(async () => { throw new Error('secret-bearing upstream failure'); }) },
    });
    const outcome = await engine.runOnce();
    expect(outcome).toEqual({ status: 'retry', runId: claim.runId, availableAt: now + 5_000 });
    expect(JSON.stringify(outcome)).not.toContain('secret-bearing');
    expect(repository.releaseForRetry).toHaveBeenCalledWith(claim.runId, 'dispatcher-a', now, now + 5_000);
  });

  it('reports lease loss instead of acknowledging a projection it could not persist', async () => {
    const { engine } = fixture({ repository: { markProjected: vi.fn(async () => false) } });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId: claim.runId });
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

  it('is idle when no durable row is available', async () => {
    const { engine, projector } = fixture({ repository: { claimNext: vi.fn(async () => null) } });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'idle' });
    expect(projector.ensure).not.toHaveBeenCalled();
  });
});
