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
  const engine = new ReviewJobDispatchEngine({
    repository,
    projector,
    workerId: 'dispatcher-a',
    workerImage: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`,
    namespace: 'ct-review-qualification',
    now: () => now,
    leaseMs: 30_000,
    retryDelayMs: 5_000,
  });
  return { engine, repository, projector };
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
    const { engine, projector, repository } = fixture({
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
