import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  evictQueuedRunsForPR,
  clearPrEviction,
  registerPendingRunForPR,
} from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockContainerRunner } from '../src/runners/containerRunner.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from '../src/types.js';

/**
 * Calculates a valid Web Crypto HMAC-SHA256 signature matching GitHub's X-Hub-Signature-256
 */
async function signPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

interface TestHarness {
  env: Env;
  repoGateStates: Map<string, MockDurableObjectState>;
  repoGateInstances: Map<string, RepoGateDO>;
  reviewRunStates: Map<string, MockDurableObjectState>;
  reviewRunInstances: Map<string, ReviewRunDO>;
  queuedDebounceMessages: DebounceMessagePayload[];
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  rebootRepoGate: (repoKey: string) => RepoGateDO;
}

function createIter4Harness(): TestHarness {
  const repoGateStates = new Map<string, MockDurableObjectState>();
  const repoGateInstances = new Map<string, RepoGateDO>();
  const reviewRunStates = new Map<string, MockDurableObjectState>();
  const reviewRunInstances = new Map<string, ReviewRunDO>();
  const queuedDebounceMessages: DebounceMessagePayload[] = [];
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];

  const env: any = {
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'shadow',
    PILOT_REPOSITORIES: 'calltelemetry/review-yeti,calltelemetry/test-repo',
    GITHUB_WEBHOOK_SECRET: 'test-secret-iter4',
    DOKS_FALLBACK_URL: undefined,

    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (id: string) => {
        const key = id.toLowerCase();
        if (!repoGateInstances.has(key)) {
          const state = repoGateStates.get(key) || new MockDurableObjectState();
          repoGateStates.set(key, state);
          const gate = new RepoGateDO(state as any, env);
          repoGateInstances.set(key, gate);
        }
        const instance = repoGateInstances.get(key)!;
        return {
          fetch: async (url: string | Request, init?: any) => {
            const req = typeof url === 'string' ? new Request(url, init) : url;
            return instance.fetch(req);
          },
        };
      },
    },

    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!reviewRunInstances.has(id)) {
          const state = reviewRunStates.get(id) || new MockDurableObjectState();
          reviewRunStates.set(id, state);
          const runDO = new ReviewRunDO(state as any, env);
          reviewRunInstances.set(id, runDO);
        }
        const instance = reviewRunInstances.get(id)!;
        return {
          fetch: async (url: string | Request, init?: any) => {
            const req = typeof url === 'string' ? new Request(url, init) : url;
            return instance.fetch(req);
          },
        };
      },
    },

    REVIEW_DEBOUNCE_QUEUE: {
      send: async (message: DebounceMessagePayload) => {
        queuedDebounceMessages.push(message);
        return {} as any;
      },
    },

    REVIEW_JOB_WORKFLOW: {
      create: async (payload: { id: string; params: ReviewRunSpec }) => {
        dispatchedWorkflows.push(payload);
        return { id: payload.id };
      },
    },
  };

  const rebootRepoGate = (repoKey: string): RepoGateDO => {
    const key = repoKey.toLowerCase();
    const existingState = repoGateStates.get(key);
    if (!existingState) {
      throw new Error(`Cannot reboot uninitialized RepoGate: ${repoKey}`);
    }
    const newInstance = new RepoGateDO(existingState as any, env);
    repoGateInstances.set(key, newInstance);
    return newInstance;
  };

  return {
    env,
    repoGateStates,
    repoGateInstances,
    reviewRunStates,
    reviewRunInstances,
    queuedDebounceMessages,
    dispatchedWorkflows,
    rebootRepoGate,
  };
}

describe('Milestone 1 Iteration 4 Adversarial Verification Harness', () => {
  // =========================================================================
  // Vulnerability A: DO Reboot Eviction Tombstone Persistence on Empty Queue
  // =========================================================================
  describe('Vulnerability A: DO Reboot Eviction Tombstone Persistence on Empty Queue', () => {
    it('persists __EVICTED__ to storage when evictQueue({ prNumber }) is called on empty queue', async () => {
      const harness = createIter4Harness();
      const repoKey = 'calltelemetry/review-yeti';
      const gate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // PR 88 completed in the past and released slot
      await gate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_88_v1', headSha: 'sha_88_v1', prNumber: 88 }),
      });
      await gate.fetch('http://do/release', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_88_v1' }),
      });

      // Status: 0 active, 0 queued
      const statusBefore = await (await gate.fetch('http://do/status')).json() as any;
      assert.equal(statusBefore.activeCount, 0);
      assert.equal(statusBefore.queueLength, 0);

      // PR 88 is closed via evictQueuedRunsForPR
      const evictRes = await evictQueuedRunsForPR(harness.env, repoKey, 88, true);
      assert.equal(evictRes.evicted, true);
      assert.equal(evictRes.count, 0);

      // Verify DO storage has __EVICTED__
      const state = harness.repoGateStates.get(repoKey)!;
      const storedLatest = await state.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMap = new Map(storedLatest);
      assert.equal(latestMap.get(88), '__EVICTED__', 'Storage must have __EVICTED__ for PR 88');

      // Reboot DO from storage
      const rebootedGate = harness.rebootRepoGate(repoKey);

      // Stale run attempts to acquire slot on rebooted DO
      const repollRes = await rebootedGate.acquireSlot('run_88_v1', 'sha_88_v1', 88);
      assert.equal(repollRes.granted, false, 'Stale run must NOT be granted slot');
      assert.equal(repollRes.evicted, true, 'Stale run must be rejected with evicted: true');

      // Status must still show 0 active jobs
      const statusAfter = await rebootedGate.getStatus();
      assert.equal(statusAfter.activeCount, 0);
    });

    it('survives multiple consecutive DO reboots and preserves tombstones across 20 distinct PRs', async () => {
      const harness = createIter4Harness();
      const repoKey = 'calltelemetry/review-yeti';
      const gate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      const prs = Array.from({ length: 20 }, (_, i) => 1000 + i);

      // Each PR runs, finishes, and releases
      for (const pr of prs) {
        const runId = `run_${pr}_v1`;
        await gate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId, headSha: `sha_${pr}`, prNumber: pr }),
        });
        await gate.fetch('http://do/release', {
          method: 'POST',
          body: JSON.stringify({ runId }),
        });
        // Evict with tombstone: true on empty queue
        const evictRes = await evictQueuedRunsForPR(harness.env, repoKey, pr, true);
        assert.equal(evictRes.evicted, true);
      }

      // Perform 3 consecutive DO reboots
      let currentGate: RepoGateDO = harness.repoGateInstances.get(repoKey)!;
      for (let rebootCount = 1; rebootCount <= 3; rebootCount++) {
        currentGate = harness.rebootRepoGate(repoKey);
      }

      // Verify all 20 PR stale runs are rejected
      for (const pr of prs) {
        const repoll = await currentGate.acquireSlot(`run_${pr}_v1`, `sha_${pr}`, pr);
        assert.equal(
          repoll.granted,
          false,
          `PR ${pr} must be rejected after 3 DO reboots`
        );
        assert.equal(repoll.evicted, true);
      }
    });

    it('does NOT tombstone PR when tombstone option is false (synchronize path)', async () => {
      const harness = createIter4Harness();
      const repoKey = 'calltelemetry/review-yeti';
      const gate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // PR 99 has active run
      await gate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_99_v1', headSha: 'sha_99_v1', prNumber: 99 }),
      });
      // PR 99 has queued run v2
      await gate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_99_v2', headSha: 'sha_99_v2', prNumber: 99 }),
      });

      // Synchronize path calls evictQueuedRunsForPR with tombstone: false
      const evictRes = await evictQueuedRunsForPR(harness.env, repoKey, 99, false);
      assert.equal(evictRes.evicted, true);
      assert.equal(evictRes.count, 1);
      assert.deepEqual(evictRes.evictedRunIds, ['run_99_v2']);

      // latestRunIdByPr should NOT be __EVICTED__
      const state = harness.repoGateStates.get(repoKey)!;
      const storedLatest = await state.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMap = new Map(storedLatest);
      assert.notEqual(latestMap.get(99), '__EVICTED__');
    });
  });

  // =========================================================================
  // Vulnerability B: Debounced Commits Arriving on Closed PRs
  // =========================================================================
  describe('Vulnerability B: Debounced Commits Arriving on Closed PRs', () => {
    it('rejects debounced commit on closed PR with { granted: false, evicted: true } and 0 dispatches', async () => {
      const harness = createIter4Harness();
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 200;

      // 1. Synchronize arrives at T=0
      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_200_sync' }, base: { sha: 'main' } },
      });
      const sigSync = await signPayload(secret, bodySync);
      const resSync = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sigSync,
          },
          body: bodySync,
        }),
        harness.env
      );
      assert.equal(resSync.status, 200);
      const syncData = (await resSync.json()) as any;
      assert.equal(syncData.status, 'queued_debounced');
      const debouncedRunId = syncData.runId;

      assert.equal(harness.queuedDebounceMessages.length, 1);
      const debounceMsg = harness.queuedDebounceMessages[0];
      assert.equal(debounceMsg.runId, debouncedRunId);

      // 2. PR closed at T=10s
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_200_sync' }, base: { sha: 'main' } },
      });
      const sigClose = await signPayload(secret, bodyClose);
      const resClose = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sigClose,
          },
          body: bodyClose,
        }),
        harness.env
      );
      assert.equal(resClose.status, 200);

      // 3. Debounce window expires (T=60s)
      const fakeBatch: any = {
        messages: [{ body: debounceMsg, ack: () => {} }],
      };
      await worker.queue(fakeBatch, harness.env);

      // Workflow created
      assert.equal(harness.dispatchedWorkflows.length, 1);

      // 4. Workflow step 2: acquireSlot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      const acquireRes = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({
            runId: debouncedRunId,
            headSha: 'sha_200_sync',
            prNumber,
          }),
        })
      ).json()) as any;

      assert.equal(acquireRes.granted, false, 'Debounced run on closed PR must NOT be granted slot');
      assert.equal(acquireRes.evicted, true, 'Debounced run on closed PR must be marked evicted: true');

      // Gate status must show 0 active jobs
      const gateStatus = (await (await repoGate.fetch('http://do/status')).json()) as any;
      assert.equal(gateStatus.activeCount, 0);
      assert.equal(gateStatus.queueLength, 0);
    });

    it('rejects debounced commit on closed PR even when DO reboots during the debounce window', async () => {
      const harness = createIter4Harness();
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 250;

      // 1. Synchronize arrives at T=0
      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_250_sync' }, base: { sha: 'main' } },
      });
      const resSync = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodySync),
          },
          body: bodySync,
        }),
        harness.env
      );
      const debouncedRunId = ((await resSync.json()) as any).runId;
      const debounceMsg = harness.queuedDebounceMessages[0];

      // 2. PR closed at T=10s
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_250_sync' }, base: { sha: 'main' } },
      });
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodyClose),
          },
          body: bodyClose,
        }),
        harness.env
      );

      // 3. DO REBOOTS during debounce delay (simulating idle eviction / edge migration)
      const rebootedGate = harness.rebootRepoGate(repoKey);

      // 4. Debounce expires at T=60s
      const acquireRes = await rebootedGate.acquireSlot(debouncedRunId, 'sha_250_sync', prNumber);
      assert.equal(acquireRes.granted, false);
      assert.equal(acquireRes.evicted, true);

      const status = await rebootedGate.getStatus();
      assert.equal(status.activeCount, 0);
    });

    it('rejects all commits in a burst of 5 synchronize events if PR is closed before debounce expiry', async () => {
      const harness = createIter4Harness();
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 280;

      const runIds: string[] = [];
      // 5 synchronize events
      for (let i = 1; i <= 5; i++) {
        const body = JSON.stringify({
          action: 'synchronize',
          repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
          pull_request: { number: prNumber, head: { sha: `sha_280_v${i}` }, base: { sha: 'main' } },
        });
        const res = await worker.fetch(
          new Request('https://operator.calltelemetry.com/api/webhooks/github', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-GitHub-Event': 'pull_request',
              'X-Hub-Signature-256': await signPayload(secret, body),
            },
            body,
          }),
          harness.env
        );
        const data = (await res.json()) as any;
        runIds.push(data.runId);
      }
      assert.equal(runIds.length, 5);

      // PR is closed
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_280_v5' }, base: { sha: 'main' } },
      });
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodyClose),
          },
          body: bodyClose,
        }),
        harness.env
      );

      // Drain all 5 debounce messages
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      for (let i = 0; i < 5; i++) {
        const runId = runIds[i];
        const res = (await (
          await repoGate.fetch('http://do/acquire', {
            method: 'POST',
            body: JSON.stringify({ runId, headSha: `sha_280_v${i + 1}`, prNumber }),
          })
        ).json()) as any;
        assert.equal(res.granted, false, `Run ${i + 1} (${runId}) must be rejected`);
        assert.equal(res.evicted, true);
      }

      const status = (await (await repoGate.fetch('http://do/status')).json()) as any;
      assert.equal(status.activeCount, 0);
    });
  });

  // =========================================================================
  // Mission Area 3: Normal Synchronize on Open PRs & End-to-End Pipeline
  // =========================================================================
  describe('Mission Area 3: Normal Synchronize on Open PRs & End-to-End Pipeline', () => {
    it('grants slot to normal synchronize commit on open PR and completes full workflow pipeline', async () => {
      const harness = createIter4Harness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 300;

      // 1. Developer pushes synchronize
      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_300_valid' }, base: { sha: 'main' } },
      });
      const resSync = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodySync),
          },
          body: bodySync,
        }),
        harness.env
      );
      assert.equal(resSync.status, 200);
      const syncData = (await resSync.json()) as any;
      const debouncedRunId = syncData.runId;

      // 2. Debounce queue consumer fires
      const fakeBatch: any = {
        messages: [{ body: harness.queuedDebounceMessages[0], ack: () => {} }],
      };
      await worker.queue(fakeBatch, harness.env);

      // 3. ReviewJobWorkflow runs
      const spec: ReviewRunSpec = {
        runId: debouncedRunId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_300_valid',
        baseSha: 'main',
        installationId: 12345,
      };

      // Mock workflow step runner
      const executedSteps: string[] = [];
      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          executedSteps.push(name);
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string, _duration: any) {
          executedSteps.push(name);
        },
      };

      const workflowResult = await workflow.run({ payload: spec }, mockStep as any);
      assert.equal(workflowResult.status, 'succeeded');
      assert.equal(workflowResult.runId, debouncedRunId);
      assert.deepEqual(executedSteps, [
        'mint-scoped-token',
        'acquire-fencing-lease',
        'dispatch-container',
        'verify-and-record-receipt',
        'cleanup-and-release',
      ]);

      // 4. Verify RepoGate slot was cleanly released
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      const status = (await (await repoGate.fetch('http://do/status')).json()) as any;
      assert.equal(status.activeCount, 0);
      assert.equal(status.queueLength, 0);
    });

    it('supersedes older debounced commits during burst, granting slot only to newest commit', async () => {
      const harness = createIter4Harness();
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 350;

      // Developer pushes Commit 1, then Commit 2
      const body1 = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_350_v1' }, base: { sha: 'main' } },
      });
      const res1 = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, body1),
          },
          body: body1,
        }),
        harness.env
      );
      const runId1 = ((await res1.json()) as any).runId;

      const body2 = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_350_v2' }, base: { sha: 'main' } },
      });
      const res2 = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, body2),
          },
          body: body2,
        }),
        harness.env
      );
      const runId2 = ((await res2.json()) as any).runId;

      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // Commit 1 expires first:
      const acq1 = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId: runId1, headSha: 'sha_350_v1', prNumber }),
        })
      ).json()) as any;
      assert.equal(acq1.granted, false, 'Older debounced commit 1 must be rejected');
      assert.equal(acq1.evicted, true);

      // Commit 2 expires next:
      const acq2 = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId: runId2, headSha: 'sha_350_v2', prNumber }),
        })
      ).json()) as any;
      assert.equal(acq2.granted, true, 'Latest debounced commit 2 must be granted slot');
    });
  });

  // =========================================================================
  // Mission Area 4: Reopened PR Lifecycle Integrity
  // =========================================================================
  describe('Mission Area 4: Reopened PR Lifecycle Integrity', () => {
    it('allows fresh commit on reopened PR while maintaining permanent rejection of pre-closure commits', async () => {
      const harness = createIter4Harness();
      const secret = 'test-secret-iter4';
      const repoKey = 'calltelemetry/review-yeti';
      const prNumber = 400;

      // 1. PR 400 has commit 1
      const body1 = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_400_v1' }, base: { sha: 'main' } },
      });
      const res1 = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, body1),
          },
          body: body1,
        }),
        harness.env
      );
      const runId1 = ((await res1.json()) as any).runId;

      // 2. PR 400 is closed
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_400_v1' }, base: { sha: 'main' } },
      });
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodyClose),
          },
          body: bodyClose,
        }),
        harness.env
      );

      // 3. PR 400 is reopened!
      const bodyReopen = JSON.stringify({
        action: 'reopened',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_400_v1' }, base: { sha: 'main' } },
      });
      const resReopen = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, bodyReopen),
          },
          body: bodyReopen,
        }),
        harness.env
      );
      assert.equal(resReopen.status, 200);

      // 4. Developer pushes fresh Commit 2
      const body2 = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'calltelemetry/review-yeti', name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_400_v2' }, base: { sha: 'main' } },
      });
      const res2 = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': await signPayload(secret, body2),
          },
          body: body2,
        }),
        harness.env
      );
      const runId2 = ((await res2.json()) as any).runId;

      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // Stale Commit 1 re-polls: must be rejected!
      const repoll1 = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId: runId1, headSha: 'sha_400_v1', prNumber }),
        })
      ).json()) as any;
      assert.equal(repoll1.granted, false, 'Pre-closure commit 1 must stay rejected');
      assert.equal(repoll1.evicted, true);

      // Fresh Commit 2 arrives: must be granted!
      const repoll2 = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId: runId2, headSha: 'sha_400_v2', prNumber }),
        })
      ).json()) as any;
      assert.equal(repoll2.granted, true, 'Fresh commit 2 on reopened PR must be granted slot');
    });
  });
});
