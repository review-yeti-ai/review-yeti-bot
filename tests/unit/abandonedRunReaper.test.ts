import { describe, expect, it, vi } from 'vitest';
import { AbandonedRunReaper } from '../../src/review/abandonedRunReaper';

const run = {
  runId: `run_${'1'.repeat(32)}`,
  owner: 'calltelemetry',
  repo: 'ct-meta',
  prNumber: 2795,
  headSha: 'a'.repeat(40),
};

function reaper(over: Record<string, any> = {}) {
  const client = {
    createCheck: vi.fn(async () => 77),
    completeCheck: vi.fn(async () => {}),
    ...over.client,
  };
  const repository = {
    claimAbandonedPublishingRuns: vi.fn(async () => [run]),
    ...over.repository,
  };
  const checkClientFor = over.checkClientFor || vi.fn(async () => client);
  return {
    client,
    repository,
    checkClientFor,
    subject: new AbandonedRunReaper({
      repository: repository as never,
      checkClientFor: checkClientFor as never,
      workerId: 'reaper-a',
      now: () => 1_700_000_000_000,
      ...over.options,
    }),
  };
}

describe('AbandonedRunReaper', () => {
  it('publishes failure — never neutral or success — for a run that never reviewed', async () => {
    // A neutral check does not block a merge, so reporting an unrun review as
    // neutral would turn a silent block into a silent pass, which is worse.
    const { subject, client } = reaper();
    const outcome = await subject.runOnce();
    expect(outcome).toEqual({ swept: 1, published: 1, failed: 0 });
    expect(client.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure', checkId: 77 }),
    );
    // The summary must say plainly that this is a failure, not a pass, so nobody
    // reads an unrun review as a clean one.
    const summary = client.completeCheck.mock.calls[0][0].summary as string;
    expect(summary).toMatch(/failed review rather than an approval/u);
    expect(summary).toContain(run.headSha);
  });

  it('creates the check on the abandoned head, in that run repository', async () => {
    const { subject, client } = reaper();
    await subject.runOnce();
    expect(client.createCheck).toHaveBeenCalledWith('calltelemetry', 'ct-meta', run.headSha);
  });

  it('builds a client per run so the token is scoped to that repository', async () => {
    // One token cannot serve two repositories; minting per run is the point.
    const second = { ...run, runId: `run_${'2'.repeat(32)}`, repo: 'cisco-cdr' };
    const { subject, checkClientFor } = reaper({
      repository: { claimAbandonedPublishingRuns: vi.fn(async () => [run, second]) },
    });
    await subject.runOnce();
    expect(checkClientFor).toHaveBeenCalledTimes(2);
    expect(checkClientFor).toHaveBeenCalledWith(expect.objectContaining({ repo: 'ct-meta' }));
    expect(checkClientFor).toHaveBeenCalledWith(expect.objectContaining({ repo: 'cisco-cdr' }));
  });

  it('keeps sweeping when one run fails to publish', async () => {
    // One unreachable repository must not strand every other blocked head.
    const bad = { ...run, runId: `run_${'3'.repeat(32)}` };
    let call = 0;
    const { subject } = reaper({
      repository: { claimAbandonedPublishingRuns: vi.fn(async () => [bad, run]) },
      checkClientFor: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('installation suspended');
        return { createCheck: vi.fn(async () => 1), completeCheck: vi.fn(async () => {}) };
      }),
    });
    await expect(subject.runOnce()).resolves.toEqual({ swept: 2, published: 1, failed: 1 });
  });

  it('does nothing when no run is abandoned', async () => {
    const { subject, checkClientFor } = reaper({
      repository: { claimAbandonedPublishingRuns: vi.fn(async () => []) },
    });
    await expect(subject.runOnce()).resolves.toEqual({ swept: 0, published: 0, failed: 0 });
    expect(checkClientFor).not.toHaveBeenCalled();
  });

  it('bounds each sweep so one pass cannot mint unboundedly', async () => {
    const { subject, repository } = reaper({ options: { limit: 5 } });
    await subject.runOnce();
    expect(repository.claimAbandonedPublishingRuns).toHaveBeenCalledWith('reaper-a', 1_700_000_000_000, 5);
  });

  it('requires a worker id so two reapers are distinguishable in the audit trail', () => {
    expect(() => new AbandonedRunReaper({
      repository: {} as never, checkClientFor: (async () => ({})) as never, workerId: '  ',
    })).toThrow(/worker id is required/u);
  });
});
