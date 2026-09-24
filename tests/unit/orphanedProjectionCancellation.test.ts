import { describe, expect, it, vi } from 'vitest';
import { ReviewJobDispatchEngine } from '../../src/k8s/reviewJobDispatchEngine';
import { recoverOrphanedProjectionCancellation } from '../../src/k8s/orphanedProjectionCancellation';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

// REL-1073 follow-up: admission cancels a run while the dispatcher holds the
// claim. The PRReviewJob gets created anyway and markProjected loses. Without
// recovery that job is never cancelled.

const receivedAt = Date.parse('2026-09-24T10:00:00.000Z');
const now = receivedAt + 60_000;
const runId = `run_${'7'.repeat(32)}`;
const projectionName = `ct-review-${'7'.repeat(32)}`;
const claim = {
  runId,
  deliveryId: 'actions:1:1:1:1:head',
  claimAttempt: 3,
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
const reopened = { runId, executionAttempt: 1, projectionName, cancelReason: 'superseded_by_new_head' };

function engineWith(overrides: {
  markProjected?: () => Promise<boolean>;
  reopen?: (...args: any[]) => Promise<any>;
  patch?: (...args: any[]) => Promise<any>;
  markCancelPropagated?: (...args: any[]) => Promise<boolean>;
  omitReopen?: boolean;
} = {}) {
  const repository = {
    claimNext: vi.fn(async () => claim),
    markProjected: vi.fn(overrides.markProjected ?? (async () => false)),
    bindWorkerTokenDigest: vi.fn(async () => true),
    releaseForRetry: vi.fn(async () => true),
    markTerminal: vi.fn(async () => true),
    markCancelPropagated: vi.fn(overrides.markCancelPropagated ?? (async () => true)),
    findPendingCancellations: vi.fn(async () => []),
    ...(overrides.omitReopen ? {} : {
      reopenOrphanedProjectionCancellation: vi.fn(overrides.reopen ?? (async () => reopened)),
    }),
  };
  const projector = {
    ensure: vi.fn(async () => undefined),
    patchCancellation: vi.fn(overrides.patch ?? (async () => ({ status: 'patched' as const, cancelRequested: true }))),
  };
  const engine = new ReviewJobDispatchEngine({
    repository,
    projector,
    workerId: 'dispatcher-a',
    workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'e'.repeat(64)}`,
    namespace: 'ct-review',
    now: () => now,
  });
  return { engine, repository, projector };
}

describe('claimed-run cancellation race (REL-1073)', () => {
  it('cancels the PRReviewJob it just created when a cancel retired the claimed row', async () => {
    const { engine, repository, projector } = engineWith();
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'lease-lost', runId, orphanedCancellation: 'propagated',
    });
    expect(projector.ensure).toHaveBeenCalledTimes(1);
    expect(repository.reopenOrphanedProjectionCancellation)
      .toHaveBeenCalledWith(runId, claim.claimAttempt, projectionName, now);
    expect(projector.patchCancellation).toHaveBeenCalledWith(projectionName, 'ct-review', 'superseded_by_new_head');
    expect(repository.markCancelPropagated).toHaveBeenCalledWith(runId, 1, now);
    // Ordering: the job must exist before the row is re-read.
    expect(projector.ensure.mock.invocationCallOrder[0])
      .toBeLessThan(repository.reopenOrphanedProjectionCancellation!.mock.invocationCallOrder[0]);
  });

  it('leaves an unverified patch to the sweep instead of marking it propagated', async () => {
    // A 2xx without the stored flag is the pruned-field case the sweep refuses
    // to count; the reopened row stays pending so the sweep retries it.
    const { engine, repository } = engineWith({ patch: async () => ({ status: 'patched', cancelRequested: false }) });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'lease-lost', runId, orphanedCancellation: 'pending-sweep',
    });
    expect(repository.markCancelPropagated).not.toHaveBeenCalled();
  });

  it('leaves a failed patch to the sweep', async () => {
    const { engine, repository } = engineWith({ patch: async () => { throw Object.assign(new Error('boom'), { statusCode: 503 }); } });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'lease-lost', runId, orphanedCancellation: 'pending-sweep',
    });
    expect(repository.markCancelPropagated).not.toHaveBeenCalled();
  });

  it('does nothing when the lost lease was not a cancellation', async () => {
    const { engine, projector } = engineWith({ reopen: async () => null });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId });
    expect(projector.patchCancellation).not.toHaveBeenCalled();
  });

  it('reports a failed re-read rather than throwing out of the dispatch cycle', async () => {
    const { engine, projector } = engineWith({ reopen: async () => { throw new Error('db down'); } });
    await expect(engine.runOnce()).resolves.toEqual({
      status: 'lease-lost', runId, orphanedCancellation: 'unrecorded',
    });
    expect(projector.patchCancellation).not.toHaveBeenCalled();
  });

  it('never re-reads on a successful projection', async () => {
    const { engine, repository, projector } = engineWith({ markProjected: async () => true });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'projected', runId, projectionName });
    expect(repository.reopenOrphanedProjectionCancellation).not.toHaveBeenCalled();
    expect(projector.patchCancellation).not.toHaveBeenCalled();
  });

  it('keeps the old outcome for a repository without the re-read', async () => {
    const { engine, projector } = engineWith({ omitReopen: true });
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId });
    expect(projector.patchCancellation).not.toHaveBeenCalled();
  });

  it('never re-reads when the PRReviewJob was not created', async () => {
    const { engine, repository, projector } = engineWith();
    projector.ensure.mockRejectedValueOnce(new Error('apiserver unavailable'));
    repository.releaseForRetry.mockResolvedValueOnce(false);
    await expect(engine.runOnce()).resolves.toEqual({ status: 'lease-lost', runId });
    expect(repository.reopenOrphanedProjectionCancellation).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanedProjectionCancellation', () => {
  it('treats a rejected cancel callback as pending for the sweep', async () => {
    await expect(recoverOrphanedProjectionCancellation({
      repository: { reopenOrphanedProjectionCancellation: async () => reopened },
      cancel: async () => { throw new Error('boom'); },
      runId, claimAttempt: 3, projectionName, now,
    })).resolves.toBe('pending-sweep');
  });
});
