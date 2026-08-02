import { describe, expect, it } from 'vitest';
import { InMemoryReviewRunRepository, PostgresReviewRunRepository } from '../../src/persistence/reviewRunRepository';
import { InMemoryReviewArtifactStore, ReviewArtifactStore } from '../../src/persistence/reviewArtifactStore';
import { ReviewWorker } from '../../src/persistence/reviewWorker';
import { PI_STAGE_CONTRACTS } from '../../src/review/piWorkflow';

const identity = {
  owner: 'calltelemetry',
  repo: 'ct-review-bot',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  snapshotDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};

function postgresThatRejectsExpiredTerminalUpdates() {
  const row = {
    run_id: 'run-stale',
    identity,
    identity_digest: 'a'.repeat(64),
    effective_policy_digest: identity.configDigest,
    effective_config_digest: identity.configDigest,
    index_epoch: 0,
    status: 'failed',
    stage: 'publish',
    attempt: 1,
    lease_owner: 'worker-a',
    lease_expires_at: new Date(1_000).toISOString(),
    artifacts: { publish: 'e'.repeat(64) },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
  return {
    query: async (text: string) => {
      const isTerminalUpdate = text.includes("status='succeeded'") || text.includes("status='failed'");
      const hasExpiryFence = text.includes('lease_expires_at > to_timestamp($3 / 1000.0)');
      return { rows: isTerminalUpdate && !hasExpiryFence ? [row] : [] };
    },
  };
}

function postgresPublicationClaimFixture(runId: string, runIdentity: typeof identity) {
  const row = {
    run_id: runId,
    identity: runIdentity,
    identity_digest: 'a'.repeat(64),
    effective_policy_digest: runIdentity.configDigest,
    effective_config_digest: runIdentity.configDigest,
    index_epoch: 0,
    status: 'running',
    stage: 'publish',
    attempt: 1,
    lease_owner: 'worker-a',
    lease_expires_at: new Date(20_000).toISOString(),
    artifacts: { publish: 'e'.repeat(64) },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };

  return {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("SET status='publishing'")) {
        return { rows: [{ ...row, status: 'publishing', publication_fence: values?.[3] }] };
      }
      return { rows: [] };
    },
  };
}

const nextStage = {
  admission: 'snapshot',
  snapshot: 'config',
  config: 'submodules',
  submodules: 'review',
  review: 'arbiter',
  arbiter: 'publish',
} as const;

async function advanceToPublish(
  repository: InMemoryReviewRunRepository,
  artifacts: InMemoryReviewArtifactStore,
  runId: string,
  workerId: string,
  now: number,
): Promise<void> {
  for (const stage of ['admission', 'snapshot', 'config', 'submodules', 'review', 'arbiter'] as const) {
    const digest = await artifacts.put(runId, stage, { stage });
    await repository.recordArtifact(runId, stage, digest, workerId, now);
    await repository.transition(runId, nextStage[stage], workerId, now);
  }
}

describe('durable Pi worker leases', () => {
  it('does not count a re-entrant claim by the current worker as a retry attempt', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });

    const firstClaim = await repository.claim(run.runId, 'worker-a', 2_000, 10_000);
    const reentrantClaim = await repository.claim(run.runId, 'worker-a', 3_000, 10_000);

    expect(firstClaim?.attempt).toBe(1);
    expect(reentrantClaim?.attempt).toBe(1);
    expect(reentrantClaim?.leaseExpiresAt).toBe(13_000);
  });

  it('extends an active lease on heartbeat without creating a retry attempt', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 10_000);

    expect(await repository.heartbeat(run.runId, 'worker-a', 5_000, 10_000)).toBe(true);
    expect((await repository.get(run.runId))?.leaseExpiresAt).toBe(15_000);
    expect((await repository.get(run.runId))?.attempt).toBe(1);
  });

  it('does not allow a competing worker to take an unexpired lease', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 10_000);

    expect(await repository.claim(run.runId, 'worker-b', 11_999, 10_000)).toBeNull();
  });

  it('bounds retries after an expired running lease is reaped back to queued', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 1_000);
    expect(await repository.reapExpiredLeases(3_001)).toBe(1);
    expect(await repository.claim(run.runId, 'worker-b', 4_000, 10_000, 1)).toBeNull();
  });

  it('recovers an expired lease from the persisted stage instead of executing that stage again', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'crashed-worker', 2_000, 1_000);
    const admissionDigest = await artifacts.put(run.runId, 'admission', { accepted: true });
    await repository.recordArtifact(run.runId, 'admission', admissionDigest, 'crashed-worker', 2_500);

    const executed: string[] = [];
    const worker = new ReviewWorker({
      repository,
      artifacts,
      leaseMs: 10_000,
      now: () => 4_000,
      executeStage: async (stage) => {
        executed.push(stage);
        return { stage, accepted: true };
      },
    });

    const completed = await worker.claimAndRun(run.runId, 'recovery-worker');

    expect(executed).not.toContain('admission');
    expect(executed).toEqual(['snapshot', 'config', 'submodules', 'review', 'arbiter', 'publish']);
    expect(completed?.status).toBe('succeeded');
    expect(completed?.attempt).toBe(2);
  });

  it('fails closed when a caller supplies a result digest different from the persisted publish artifact', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 10_000);

    await advanceToPublish(repository, artifacts, run.runId, 'worker-a', 2_500);
    const publishDigest = await artifacts.put(run.runId, 'publish', { published: true });
    await repository.recordArtifact(run.runId, 'publish', publishDigest, 'worker-a', 2_500);

    await expect(repository.succeed(run.runId, 'worker-a', 3_000, '0'.repeat(64))).rejects.toThrow(/result digest/i);
  });

  it('rejects a transition until the current stage artifact is persisted', async () => {
    const repository = new InMemoryReviewRunRepository();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 10_000);

    await expect(repository.transition(run.runId, 'snapshot', 'worker-a', 3_000)).rejects.toThrow(/artifact/i);
  });

  it('does not let PostgreSQL terminalize a stale lease', async () => {
    const repository = new PostgresReviewRunRepository(postgresThatRejectsExpiredTerminalUpdates());

    await expect(repository.succeed('run-stale', 'worker-a', 2_000, 'e'.repeat(64))).rejects.toThrow(/cannot succeed/i);
    await expect(repository.fail('run-stale', 'worker-a', 2_000, 'lease expired')).rejects.toThrow(/cannot fail/i);
  });

  it('binds PostgreSQL lease claims and heartbeats to current-time parameters', async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const repository = new PostgresReviewRunRepository({
      query: async (text, values) => {
        queries.push({ text, values });
        return { rows: [] };
      },
    });

    await repository.claim('run-lease', 'worker-a', 2_000, 10_000);
    await repository.heartbeat('run-lease', 'worker-a', 3_000, 10_000);

    expect(queries[0].text).toContain('lease_owner=$2 AND lease_expires_at > to_timestamp($4 / 1000.0)');
    expect(queries[0].values).toEqual(['run-lease', 'worker-a', 12_000, 2_000, 3]);
    expect(queries[1].text).toContain('lease_expires_at=to_timestamp($3 / 1000.0)');
    expect(queries[1].text).toContain('updated_at=to_timestamp($4 / 1000.0)');
    expect(queries[1].values).toEqual(['run-lease', 'worker-a', 13_000, 3_000]);
  });

  it('atomically grants only one stable publication fence to competing workers', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 10_000);
    await advanceToPublish(repository, artifacts, run.runId, 'worker-a', 2_500);

    const [first, second] = await Promise.all([
      repository.claimPublication(run.runId, 'worker-a', 3_000),
      repository.claimPublication(run.runId, 'worker-b', 3_000),
    ]);
    const winner = first || second;
    const winnerId = first ? 'worker-a' : 'worker-b';

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(winner?.status).toBe('publishing');
    expect(winner?.publicationFence).toMatch(/^[a-f0-9]{64}$/);
    expect((await repository.claimPublication(run.runId, winnerId, 3_500))?.publicationFence).toBe(winner?.publicationFence);
    expect(await repository.claimPublication(run.runId, winnerId === 'worker-a' ? 'worker-b' : 'worker-a', 3_500)).toBeNull();
  });

  it('generates the same publication fence in memory and PostgreSQL repositories', async () => {
    const memoryRepository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await memoryRepository.createOrGet({ identity, now: 1_000 });
    await memoryRepository.claim(run.runId, 'worker-a', 2_000, 10_000);
    await advanceToPublish(memoryRepository, artifacts, run.runId, 'worker-a', 2_500);

    const memoryClaim = await memoryRepository.claimPublication(run.runId, 'worker-a', 3_000);
    const postgresRepository = new PostgresReviewRunRepository(postgresPublicationClaimFixture(run.runId, identity));
    const postgresClaim = await postgresRepository.claimPublication(run.runId, 'worker-a', 3_000);

    expect(memoryClaim?.publicationFence).toMatch(/^[a-f0-9]{64}$/);
    expect(postgresClaim?.publicationFence).toBe(memoryClaim?.publicationFence);
  });

  it('does not let cancellation, supersession, or reaping revoke a publication claim', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'worker-a', 2_000, 1_000);
    await advanceToPublish(repository, artifacts, run.runId, 'worker-a', 2_500);
    const claim = await repository.claimPublication(run.runId, 'worker-a', 2_600);

    expect(await repository.cancel(run.runId, 2_700, 'pull request closed')).toBeNull();
    const newer = await repository.createOrGet({
      identity: { ...identity, headSha: 'e'.repeat(40), snapshotDigest: 'f'.repeat(64) },
      now: 2_800,
    });
    expect((await repository.get(run.runId))?.status).toBe('publishing');
    expect((await repository.get(run.runId))?.publicationFence).toBe(claim?.publicationFence);
    expect(newer.status).toBe('queued');
    expect(await repository.claim(run.runId, 'worker-b', 3_001, 10_000)).toBeNull();

    expect(await repository.reapExpiredLeases(3_001)).toBe(1);
    expect((await repository.get(run.runId))?.status).toBe('failed');
    expect(await repository.claim(run.runId, 'worker-b', 3_002, 10_000)).toBeNull();
  });

  it.each([
    ['reaping', async (repository: InMemoryReviewRunRepository, runId: string) => {
      await repository.reapExpiredLeases(40_000);
    }, 'queued'],
    ['cancellation', async (repository: InMemoryReviewRunRepository, runId: string) => {
      await repository.cancel(runId, 2_000, 'pull request closed');
    }, 'cancelled'],
    ['supersession', async (repository: InMemoryReviewRunRepository) => {
      await repository.createOrGet({
        identity: { ...identity, headSha: 'e'.repeat(40), snapshotDigest: 'f'.repeat(64) },
        now: 2_000,
      });
    }, 'superseded'],
  ] as const)('does not publish when %s wins immediately before the publication claim', async (_name, interrupt, status) => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    const repositoryWithClaimHook = repository as InMemoryReviewRunRepository & {
      claimPublication: InMemoryReviewRunRepository['claimPublication'];
    };
    repositoryWithClaimHook.claimPublication = async (runId) => {
      await interrupt(repository, runId);
      return null;
    };
    const executed: string[] = [];
    const worker = new ReviewWorker({
      repository: repositoryWithClaimHook,
      artifacts,
      leaseMs: 10_000,
      now: () => 2_000,
      executeStage: async (stage) => {
        executed.push(stage);
        return { stage };
      },
    });

    const completed = await worker.claimAndRun(run.runId, 'worker-a');

    expect(executed).not.toContain('publish');
    expect(completed?.status).toBe(status);
  });

  it('passes the persisted publication fence to the publish stage context', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    let publicationFence: string | undefined;
    const worker = new ReviewWorker({
      repository,
      artifacts,
      now: () => 2_000,
      executeStage: async (stage, context) => {
        if (stage === 'publish') {
          publicationFence = context.publicationFence;
          expect(context.run.status).toBe('publishing');
        }
        return { stage };
      },
    });

    const completed = await worker.claimAndRun(run.runId, 'worker-a');

    expect(completed?.status).toBe('succeeded');
    expect(publicationFence).toMatch(/^[a-f0-9]{64}$/);
    expect(completed?.publicationFence).toBe(publicationFence);
  });

  it('requeues a retryable stage failure with a cleared lease and resumes it on the next attempt', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    let snapshotAttempts = 0;
    const worker = new ReviewWorker({
      repository,
      artifacts,
      now: () => 2_000,
      executeStage: async (stage) => {
        if (stage === 'snapshot' && ++snapshotAttempts === 1) throw new Error('snapshot provider unavailable');
        return { stage };
      },
    });

    const requeued = await worker.claimAndRun(run.runId, 'worker-a');

    expect(requeued?.status).toBe('queued');
    expect(requeued?.stage).toBe('snapshot');
    expect(requeued?.leaseOwner).toBeUndefined();
    expect(requeued?.leaseExpiresAt).toBeUndefined();
    expect(requeued?.error).toContain('snapshot provider unavailable');

    const completed = await worker.claimAndRun(run.runId, 'worker-b');
    expect(completed?.status).toBe('succeeded');
    expect(completed?.attempt).toBe(2);
    expect(snapshotAttempts).toBe(2);
  });

  it('terminally fails a retryable stage after the bounded attempt limit', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    let snapshotAttempts = 0;
    const worker = new ReviewWorker({
      repository,
      artifacts,
      maxAttempts: 2,
      now: () => 2_000,
      executeStage: async (stage) => {
        if (stage === 'snapshot') {
          snapshotAttempts += 1;
          throw new Error('snapshot provider unavailable');
        }
        return { stage };
      },
    });

    expect((await worker.claimAndRun(run.runId, 'worker-a'))?.status).toBe('queued');
    expect((await worker.claimAndRun(run.runId, 'worker-b'))?.status).toBe('failed');
    expect(await worker.claimAndRun(run.runId, 'worker-c')).toBeNull();
    expect(snapshotAttempts).toBe(2);
  });

  it('terminally fails nonretryable admission and never retries publish', async () => {
    const admissionRepository = new InMemoryReviewRunRepository();
    const admissionArtifacts = new InMemoryReviewArtifactStore();
    const admissionRun = await admissionRepository.createOrGet({ identity, now: 1_000 });
    const admissionWorker = new ReviewWorker({
      repository: admissionRepository,
      artifacts: admissionArtifacts,
      now: () => 2_000,
      executeStage: async () => {
        throw new Error('invalid admission');
      },
    });

    expect((await admissionWorker.claimAndRun(admissionRun.runId, 'worker-a'))?.status).toBe('failed');

    const publishRepository = new InMemoryReviewRunRepository();
    const publishArtifacts = new InMemoryReviewArtifactStore();
    const publishRun = await publishRepository.createOrGet({ identity: { ...identity, prNumber: 43 }, now: 1_000 });
    let publishAttempts = 0;
    const publishWorker = new ReviewWorker({
      repository: publishRepository,
      artifacts: publishArtifacts,
      now: () => 2_000,
      executeStage: async (stage) => {
        if (stage === 'publish') {
          publishAttempts += 1;
          throw new Error('ambiguous publication failure');
        }
        return { stage };
      },
    });

    expect((await publishWorker.claimAndRun(publishRun.runId, 'worker-a'))?.status).toBe('failed');
    expect(await publishWorker.claimAndRun(publishRun.runId, 'worker-b')).toBeNull();
    expect(publishAttempts).toBe(1);
  });

  it('rejects a current artifact pointer mismatch before validation or execution', async () => {
    const repository = new InMemoryReviewRunRepository();
    const artifacts = new InMemoryReviewArtifactStore();
    const run = await repository.createOrGet({ identity, now: 1_000 });
    await repository.claim(run.runId, 'crashed-worker', 2_000, 1_000);
    await artifacts.put(run.runId, 'admission', { accepted: true });
    await repository.recordArtifact(run.runId, 'admission', 'f'.repeat(64), 'crashed-worker', 2_500);

    const admissionContract = PI_STAGE_CONTRACTS.admission as { validateInput: (input: unknown) => boolean };
    const originalValidateInput = admissionContract.validateInput;
    let validationCalls = 0;
    let executionCalls = 0;
    admissionContract.validateInput = (input) => {
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
      admissionContract.validateInput = originalValidateInput;
    }
  });

  it('detects corrupted payloads in the in-memory artifact store', async () => {
    const artifacts = new InMemoryReviewArtifactStore();
    const runId = 'run_corrupt';
    await artifacts.put(runId, 'admission', { accepted: true });
    const stored = artifacts as unknown as {
      artifacts: Map<string, { payload: { accepted: boolean } }>;
    };
    stored.artifacts.get(`${runId}:admission`)!.payload = { accepted: false };

    await expect(artifacts.get(runId, 'admission')).rejects.toThrow(/integrity verification/i);
  });
});
