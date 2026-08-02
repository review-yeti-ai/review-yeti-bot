import { describe, expect, it } from 'vitest';
import { InMemoryReviewRunRepository } from '../../src/persistence/reviewRunRepository';
import { assertStageTransition, PI_STAGES } from '../../src/review/piWorkflow';

const identity = {
  owner: 'calltelemetry',
  repo: 'ct-review-bot',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};

describe('durable Pi review run state', () => {
  it('creates one idempotent run identity and claims it with a lease', async () => {
    const repository = new InMemoryReviewRunRepository();
    const first = await repository.createOrGet({ identity, now: 1_000 });
    const duplicate = await repository.createOrGet({ identity, now: 2_000 });

    expect(duplicate.runId).toBe(first.runId);
    expect((await repository.claim(first.runId, 'worker-a', 3_000, 10_000))?.leaseOwner).toBe('worker-a');
    expect(await repository.claim(first.runId, 'worker-b', 4_000, 10_000)).toBeNull();
    expect(await repository.heartbeat(first.runId, 'worker-a', 5_000, 10_000)).toBe(true);
    expect(await repository.claim(first.runId, 'worker-b', 20_000, 10_000)).not.toBeNull();
  });

  it('enforces the Pi stage graph and persists failure rather than implying success', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 1_500, 10_000);

    expect(PI_STAGES).toEqual(['admission', 'snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish', 'complete']);
    expect(() => assertStageTransition('admission', 'review')).toThrow(/invalid/i);
    await repository.transition(run.runId, 'snapshot', 'worker-a', 2_000);
    await repository.fail(run.runId, 'worker-a', 4_000, 'provider response malformed');
    const stored = await repository.get(run.runId);

    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain('malformed');
    expect(stored?.stage).toBe('snapshot');
    expect(() => assertStageTransition('snapshot', 'complete')).toThrow(/invalid/i);
  });
});
