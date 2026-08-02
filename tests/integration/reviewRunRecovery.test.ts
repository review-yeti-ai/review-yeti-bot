import { describe, expect, it } from 'vitest';
import { InMemoryReviewArtifactStore } from '../../src/persistence/reviewArtifactStore';
import { InMemoryReviewRunRepository } from '../../src/persistence/reviewRunRepository';
import { ReviewWorker } from '../../src/persistence/reviewWorker';
import { PI_STAGE_CONTRACTS } from '../../src/review/piWorkflow';

const baseIdentity = {
  owner: 'calltelemetry',
  repo: 'ct-review-bot',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};

describe('review run recovery', () => {
  it('deduplicates a matching admission and supersedes an unfinished older head', async () => {
    const repository = new InMemoryReviewRunRepository();
    const first = await repository.createOrGet({ identity: baseIdentity, now: 1_000 });
    const duplicate = await repository.createOrGet({ identity: baseIdentity, now: 2_000 });
    const newer = await repository.createOrGet({
      identity: { ...baseIdentity, headSha: 'e'.repeat(40), snapshotDigest: 'f'.repeat(64) },
      now: 3_000,
    });

    expect(duplicate.runId).toBe(first.runId);
    expect((await repository.get(first.runId))?.status).toBe('superseded');
    expect(newer.status).toBe('queued');
  });

  it('does not execute a cancelled run', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity: baseIdentity, now: 1_000 });
    await repository.cancel(run.runId, 2_000, 'pull request closed');
    const worker = new ReviewWorker({
      repository,
      artifacts,
      now: () => 3_000,
      executeStage: async () => ({ shouldNotRun: true }),
    });

    expect(await worker.claimAndRun(run.runId, 'worker-a')).toBeNull();
    expect((await repository.get(run.runId))?.error).toBe('pull request closed');
  });

  it('reaps an expired lease so a fresh worker can reclaim the run', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity: baseIdentity, now: 1_000 });
    await repository.claim(run.runId, 'dead-worker', 2_000, 1_000);

    expect(await repository.reapExpiredLeases(3_001)).toBe(1);
    expect((await repository.get(run.runId))?.status).toBe('queued');
    expect((await repository.get(run.runId))?.leaseOwner).toBeUndefined();
  });

  it('reconstructs and validates prior artifacts after a post-transition restart', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity: baseIdentity, now: 1_000 });
    await repository.claim(run.runId, 'crashed-worker', 2_000, 1_000);

    const admission = { accepted: true };
    const admissionDigest = await artifacts.put(run.runId, 'admission', admission);
    await repository.recordArtifact(run.runId, 'admission', admissionDigest, 'crashed-worker', 2_500);
    await repository.transition(run.runId, 'snapshot', 'crashed-worker', 2_500);
    const snapshot = { tree: 'clean' };
    const snapshotDigest = await artifacts.put(run.runId, 'snapshot', snapshot);
    await repository.recordArtifact(run.runId, 'snapshot', snapshotDigest, 'crashed-worker', 2_500);
    await repository.transition(run.runId, 'config', 'crashed-worker', 2_500);

    const configContract = PI_STAGE_CONTRACTS.config as { validateInput: (input: unknown) => boolean };
    const originalValidateInput = configContract.validateInput;
    const validatedInputs: unknown[] = [];
    configContract.validateInput = (input) => {
      validatedInputs.push(input);
      return originalValidateInput(input);
    };

    let recoveredArtifacts: unknown;
    try {
      const worker = new ReviewWorker({
        repository,
        artifacts,
        now: () => 4_000,
        executeStage: async (stage, context) => {
          if (stage === 'config') recoveredArtifacts = { ...context.artifacts };
          return { stage };
        },
      });

      const completed = await worker.claimAndRun(run.runId, 'recovery-worker');

      expect(completed?.status).toBe('succeeded');
      expect(recoveredArtifacts).toEqual({ admission, snapshot });
      expect(validatedInputs).toContainEqual({ admission, snapshot });
    } finally {
      configContract.validateInput = originalValidateInput;
    }
  });

  it('fails recovery before validation or execution when a predecessor pointer does not match its payload', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity: baseIdentity, now: 1_000 });
    await repository.claim(run.runId, 'crashed-worker', 2_000, 1_000);

    await artifacts.put(run.runId, 'admission', { accepted: true });
    await repository.recordArtifact(run.runId, 'admission', 'f'.repeat(64), 'crashed-worker', 2_500);
    await repository.transition(run.runId, 'snapshot', 'crashed-worker', 2_500);

    const snapshotContract = PI_STAGE_CONTRACTS.snapshot as { validateInput: (input: unknown) => boolean };
    const originalValidateInput = snapshotContract.validateInput;
    let validationCalls = 0;
    let executionCalls = 0;
    snapshotContract.validateInput = (input) => {
      validationCalls += 1;
      return originalValidateInput(input);
    };

    try {
      const worker = new ReviewWorker({
        repository,
        artifacts,
        now: () => 4_000,
        executeStage: async () => {
          executionCalls += 1;
          return { shouldNotRun: true };
        },
      });

      const failed = await worker.claimAndRun(run.runId, 'recovery-worker');

      expect(failed?.status).toBe('failed');
      expect(failed?.error).toMatch(/artifact pointer/i);
      expect(validationCalls).toBe(0);
      expect(executionCalls).toBe(0);
    } finally {
      snapshotContract.validateInput = originalValidateInput;
    }
  });
});
