import { describe, expect, it, vi } from 'vitest';
import { AbandonedRunReaper, type ReaperCheckClient } from '../../src/review/abandonedRunReaper';
import type { AbandonedPublishingRun } from '../../src/persistence/reviewDispatchRepository';
import { logger } from '../../src/utils/logger';

const run: AbandonedPublishingRun = {
  runId: `run_${'1'.repeat(32)}`, owner: 'calltelemetry', repo: 'ct-meta',
  prNumber: 2795, headSha: 'a'.repeat(40), deliveryId: 'delivery-1',
  executionAttempt: 1, receivedAt: 1_000, terminalDeadline: 901_000,
};

function fixture() {
  const client = {
    failAbandonedCheck: vi.fn(async (_run: AbandonedPublishingRun, _appId: number, _signal: AbortSignal): Promise<'failed' | 'already-completed'> => 'failed'),
  };
  const repository = {
    claimAbandonedPublishingRuns: vi.fn(async () => [run]),
    reconcileAbandonedPublishingRun: vi.fn(async (
      _run: AbandonedPublishingRun, _worker: string, _now: number,
      publish: () => Promise<'failed' | 'already-completed' | void>,
    ) => { await publish(); return true; }),
  };
  const checkClientFor = vi.fn(async (_run: AbandonedPublishingRun, _signal: AbortSignal) => client);
  const subject = new AbandonedRunReaper({
    repository, checkClientFor, workerId: 'reaper-a', publisherAppId: 4385771,
    now: () => 902_000, limit: 5,
  });
  return { client, repository, checkClientFor, subject };
}

describe('AbandonedRunReaper exact-attempt ownership', () => {
  it('publishes only through the locked attempt and authenticated App failure-only operation', async () => {
    const { subject, client, repository } = fixture();
    await expect(subject.runOnce()).resolves.toEqual({ swept: 1, published: 1, failed: 0 });
    expect(repository.claimAbandonedPublishingRuns).toHaveBeenCalledWith('reaper-a', 902_000, 5);
    expect(repository.reconcileAbandonedPublishingRun).toHaveBeenCalledWith(run, 'reaper-a', 902_000, expect.any(Function));
    expect(client.failAbandonedCheck).toHaveBeenCalledWith(run, 4385771, expect.any(AbortSignal));
  });

  it('reconciles already-completed check runs without re-publishing failure', async () => {
    const { subject, client, repository } = fixture();
    client.failAbandonedCheck.mockResolvedValueOnce('already-completed');
    let capturedOutcome: unknown;
    repository.reconcileAbandonedPublishingRun.mockImplementationOnce(async (_run, _worker, _now, publish) => {
      capturedOutcome = await publish();
      return true;
    });
    await expect(subject.runOnce()).resolves.toEqual({ swept: 1, published: 0, failed: 0 });
    expect(capturedOutcome).toBe('already-completed');
  });

  it('does not mint or publish if re-admission invalidated the claimed delivery', async () => {
    const { subject, repository, checkClientFor } = fixture();
    repository.reconcileAbandonedPublishingRun.mockResolvedValue(false);
    await expect(subject.runOnce()).resolves.toEqual({ swept: 1, published: 0, failed: 0 });
    expect(checkClientFor).not.toHaveBeenCalled();
  });

  it('mints per repository and keeps sweeping after a failed publication without logging private responses', async () => {
    const { subject, repository, checkClientFor } = fixture();
    const second = { ...run, runId: `run_${'2'.repeat(32)}`, repo: 'ct-release' };
    repository.claimAbandonedPublishingRuns.mockResolvedValue([run, second]);
    checkClientFor.mockRejectedValueOnce(new Error('private token response'));
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(subject.runOnce()).resolves.toEqual({ swept: 2, published: 1, failed: 1 });
      expect(checkClientFor).toHaveBeenCalledWith(run, expect.any(AbortSignal));
      expect(checkClientFor).toHaveBeenCalledWith(second, expect.any(AbortSignal));
      expect(JSON.stringify(log.mock.calls)).not.toContain('private token response');
    } finally { log.mockRestore(); }
  });

  it('does nothing when there are no expired attempts', async () => {
    const { subject, repository, checkClientFor } = fixture();
    repository.claimAbandonedPublishingRuns.mockResolvedValue([]);
    await expect(subject.runOnce()).resolves.toEqual({ swept: 0, published: 0, failed: 0 });
    expect(checkClientFor).not.toHaveBeenCalled();
  });

  it('does not claim after cancellation', async () => {
    const { subject, repository } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(subject.runOnce(controller.signal)).resolves.toEqual({ swept: 0, published: 0, failed: 0 });
    expect(repository.claimAbandonedPublishingRuns).not.toHaveBeenCalled();
  });

  it('drains ordinary cancellation inside publication and leaves its acknowledgement uncommitted', async () => {
    const { subject, client, repository } = fixture();
    const controller = new AbortController();
    let acknowledged = false;
    repository.reconcileAbandonedPublishingRun.mockImplementation(async (_run, _worker, _now, publish) => {
      await publish();
      acknowledged = true;
      return true;
    });
    client.failAbandonedCheck.mockImplementation(async (_run, _appId, signal) => {
      controller.abort();
      signal.throwIfAborted();
      return 'failed';
    });
    await expect(subject.runOnce(controller.signal)).resolves.toEqual({ swept: 1, published: 0, failed: 1 });
    expect(acknowledged).toBe(false);
  });

  it('requires a trusted publisher identity and a named lease owner', () => {
    const options = { repository: {} as never, checkClientFor: vi.fn(), publisherAppId: 4385771, workerId: ' ' };
    expect(() => new AbandonedRunReaper(options)).toThrow('worker id');
    expect(() => new AbandonedRunReaper({ ...options, workerId: 'reaper', publisherAppId: 0 })).toThrow('App id');
  });
});
