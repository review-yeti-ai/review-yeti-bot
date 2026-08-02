import { describe, expect, it } from 'vitest';
import { InMemoryReviewArtifactStore } from '../../src/persistence/reviewArtifactStore';
import { InMemoryReviewRunRepository } from '../../src/persistence/reviewRunRepository';
import { ReviewWorker } from '../../src/persistence/reviewWorker';

describe('generational review engine end-to-end workflow', () => {
  it('executes every durable Pi stage and completes only after publication', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const identity = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
    };
    const run = await repository.createOrGet({ identity, now: 1_000 });
    const executed: string[] = [];
    const worker = new ReviewWorker({
      repository,
      artifacts,
      now: () => 2_000,
      executeStage: async (stage, context) => {
        executed.push(`${stage}:${context.run.identity.headSha}`);
        return { stage, exactHead: context.run.identity.headSha, publicationFence: context.publicationFence || null };
      },
    });

    const completed = await worker.claimAndRun(run.runId, 'e2e-worker');

    expect(completed).toMatchObject({ status: 'succeeded', stage: 'complete', resultDigest: expect.any(String) });
    expect(executed.map((entry) => entry.split(':')[0])).toEqual(['admission', 'snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish']);
    expect(executed.every((entry) => entry.endsWith(identity.headSha))).toBe(true);
    expect(completed?.artifacts).toEqual(expect.objectContaining({ admission: expect.any(String), publish: expect.any(String) }));
  });
});
