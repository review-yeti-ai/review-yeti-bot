import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
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
  env: any;
  repoGateStates: Map<string, MockDurableObjectState>;
  repoGateInstances: Map<string, RepoGateDO>;
  reviewRunStates: Map<string, MockDurableObjectState>;
  reviewRunInstances: Map<string, ReviewRunDO>;
  queuedDebounceMessages: DebounceMessagePayload[];
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
}

function createHarness(): TestHarness {
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
          const state = new MockDurableObjectState();
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
          const state = new MockDurableObjectState();
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

  return {
    env,
    repoGateStates,
    repoGateInstances,
    reviewRunStates,
    reviewRunInstances,
    queuedDebounceMessages,
    dispatchedWorkflows,
  };
}

describe('M1 Challenger 2 Iteration 4: Empirical Concurrency Stress & Reopen Lifecycle Suite', () => {
  // =========================================================================
  // Challenge 1: Rapid Bursts & Concurrency Contention
  // =========================================================================
  describe('Challenge 1: Rapid Bursts & Concurrency Contention', () => {
    it('executes a 100-request concurrent webhook burst across 5 PRs with mixed synchronize, closed, reopened, and opened', async () => {
      const harness = createHarness();
      const secret = 'test-secret-iter4';
      const repoFullName = 'calltelemetry/review-yeti';
      const repoKey = repoFullName.toLowerCase();
      const prs = [301, 302, 303, 304, 305];
      const actions = ['opened', 'synchronize', 'closed', 'reopened', 'synchronize'] as const;

      const burstStart = performance.now();
      const tasks: Promise<any>[] = [];

      for (let i = 0; i < 100; i++) {
        const prNumber = prs[i % prs.length];
        const action = actions[i % actions.length];
        const isDraft = false;

        tasks.push(
          (async () => {
            const body = JSON.stringify({
              action,
              repository: {
                full_name: repoFullName,
                name: 'review-yeti',
                owner: { login: 'calltelemetry' },
              },
              pull_request: {
                number: prNumber,
                draft: isDraft,
                head: { sha: `sha_${prNumber}_req${i}` },
                base: { sha: 'main' },
              },
            });
            const sig = await signPayload(secret, body);
            const req = new Request('https://operator.calltelemetry.com/api/webhooks/github', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-GitHub-Event': 'pull_request',
                'X-Hub-Signature-256': sig,
              },
              body,
            });
            const res = await worker.fetch(req, harness.env);
            const resJson = await res.json();
            return { idx: i, prNumber, action, status: res.status, body: resJson };
          })()
        );
      }

      const results = await Promise.all(tasks);
      const totalDuration = performance.now() - burstStart;

      // Assert SLA: all 100 requests complete in < 3000ms
      assert.ok(
        totalDuration < 3000,
        `Burst of 100 webhook requests took ${totalDuration.toFixed(2)}ms, exceeding 3000ms SLA`
      );

      // Verify every request succeeded with HTTP 200 and expected status
      for (const r of results) {
        assert.equal(r.status, 200, `Request ${r.idx} (${r.action}) returned status ${r.status}`);
        if (r.action === 'opened') {
          assert.equal(r.body.status, 'dispatched_immediate');
        } else if (r.action === 'synchronize') {
          assert.equal(r.body.status, 'queued_debounced');
        } else if (r.action === 'closed') {
          assert.equal(r.body.status, 'cancelled');
        } else if (r.action === 'reopened') {
          assert.equal(r.body.status, 'ignored');
        }
      }

      // Verify RepoGateDO remains healthy and consistent
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      const gateStatus = (await (await repoGate.fetch('http://do/status')).json()) as any;
      assert.ok(typeof gateStatus.activeCount === 'number');
      assert.ok(typeof gateStatus.queueLength === 'number');
      assert.ok(gateStatus.activeCount <= 1, 'MaxConcurrency=1 must never be violated');
    });

    it('handles 20 simultaneous synchronize pushes for the exact same PR racing in parallel', async () => {
      const harness = createHarness();
      const secret = 'test-secret-iter4';
      const repoFullName = 'calltelemetry/review-yeti';
      const repoKey = repoFullName.toLowerCase();
      const prNumber = 401;

      // Occupy gate slot with a background job
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_background', headSha: 'sha_bg', prNumber: 999 }),
      });

      // Fire 20 synchronize events simultaneously
      const burst = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const body = JSON.stringify({
            action: 'synchronize',
            repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
            pull_request: { number: prNumber, head: { sha: `sha_401_commit_${i}` }, base: { sha: 'main' } },
          });
          const sig = await signPayload(secret, body);
          const res = await worker.fetch(
            new Request('https://operator.calltelemetry.com/api/webhooks/github', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-GitHub-Event': 'pull_request',
                'X-Hub-Signature-256': sig,
              },
              body,
            }),
            harness.env
          );
          return (await res.json()) as any;
        })
      );

      assert.equal(burst.length, 20);
      for (const b of burst) {
        assert.equal(b.status, 'queued_debounced');
      }

      // All 20 were enqueued to the debounce queue
      assert.equal(harness.queuedDebounceMessages.length, 20);

      // Now process all 20 messages through the debounce queue consumer
      const fakeBatch: any = {
        messages: harness.queuedDebounceMessages.map((msg) => ({
          body: msg,
          ack: () => {},
        })),
      };
      await worker.queue(fakeBatch, harness.env);

      // All 20 workflows created
      assert.equal(harness.dispatchedWorkflows.length, 20);

      // Now all 20 workflows attempt to acquire the slot in RepoGateDO
      // The LAST registered run for PR 401 should be valid; all earlier runs should be superseded!
      const acquireResults = await Promise.all(
        harness.dispatchedWorkflows.map(async (wf) => {
          const res = await repoGate.fetch('http://do/acquire', {
            method: 'POST',
            body: JSON.stringify({
              runId: wf.params.runId,
              headSha: wf.params.headSha,
              prNumber: wf.params.prNumber,
            }),
          });
          return { runId: wf.params.runId, result: (await res.json()) as any };
        })
      );

      // Verify that at most ONE run for PR 401 was placed in the queue or granted
      const grantedOrQueued = acquireResults.filter(
        (r) => r.result.granted === true || (r.result.queuePosition && !r.result.evicted)
      );
      assert.equal(
        grantedOrQueued.length,
        1,
        `Expected exactly 1 surviving run for PR 401, but found: ${grantedOrQueued.length}`
      );

      // The other 19 runs were rejected as superseded
      const evictedRuns = acquireResults.filter((r) => r.result.evicted === true);
      assert.equal(evictedRuns.length, 19, 'All 19 superseded runs must be rejected with evicted: true');
    });
  });

  // =========================================================================
  // Challenge 2: In-Place Re-Polling Queue Seniority Preservation
  // =========================================================================
  describe('Challenge 2: In-Place Re-Polling Queue Seniority Preservation', () => {
    it('maintains strict FIFO order and enqueuedAt timestamps during 500 concurrent interleaved re-polls', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Slot occupied
      const rActive = await gate.acquireSlot('run_active_holder', 'sha_holder', 1);
      assert.equal(rActive.granted, true);

      // Enqueue 5 PRs in specific FIFO sequence
      const prs = [10, 20, 30, 40, 50];
      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i];
        const res = await gate.acquireSlot(`run_pr_${pr}`, `sha_${pr}_initial`, pr);
        assert.equal(res.granted, false);
        assert.equal(res.queuePosition, i + 1);
      }

      // Record baseline queue state
      const initialQueue = (await state.storage.get<any[]>('queue'))!;
      assert.equal(initialQueue.length, 5);
      const initialEnqueuedAt = new Map(initialQueue.map((item) => [item.runId, item.enqueuedAt]));

      // Concurrently fire 500 re-polls randomly distributed across the 5 queued runs
      const pollTasks: Promise<any>[] = [];
      for (let i = 0; i < 500; i++) {
        const pr = prs[Math.floor(Math.random() * prs.length)];
        const runId = `run_pr_${pr}`;
        const headSha = `sha_${pr}_poll_${i}`;
        pollTasks.push(
          gate.acquireSlot(runId, headSha, pr).then((res) => ({ pr, runId, res }))
        );
      }

      const pollResults = await Promise.all(pollTasks);
      assert.equal(pollResults.length, 500);

      // Every poll must return granted: false, evicted: undefined/false, and its correct relative queue position
      for (const p of pollResults) {
        assert.equal(p.res.granted, false);
        assert.equal(p.res.evicted, undefined);
        const expectedIndex = prs.indexOf(p.pr) + 1;
        assert.equal(
          p.res.queuePosition,
          expectedIndex,
          `PR ${p.pr} returned queuePosition ${p.res.queuePosition}, expected ${expectedIndex}`
        );
      }

      // Verify raw storage queue: order and enqueuedAt timestamps must be perfectly intact
      const finalQueue = (await state.storage.get<any[]>('queue'))!;
      assert.equal(finalQueue.length, 5);
      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i];
        const expectedRunId = `run_pr_${pr}`;
        assert.equal(finalQueue[i].runId, expectedRunId, `Index ${i} runId must be ${expectedRunId}`);
        assert.equal(finalQueue[i].prNumber, pr, `Index ${i} prNumber must be ${pr}`);
        assert.equal(
          finalQueue[i].enqueuedAt,
          initialEnqueuedAt.get(expectedRunId),
          `Index ${i} enqueuedAt timestamp must remain strictly unaltered`
        );
      }

      // Sequentially release slots and assert promotion strictly matches the original FIFO sequence
      for (let i = 0; i < prs.length; i++) {
        const currentHolder = i === 0 ? 'run_active_holder' : `run_pr_${prs[i - 1]}`;
        const expectedNext = `run_pr_${prs[i]}`;
        const rel = await gate.releaseSlot(currentHolder);
        assert.equal(rel.released, true);
        assert.equal(rel.nextRunId, expectedNext, `Promotion step ${i + 1} must promote ${expectedNext}`);
      }

      // Final release unblocks to empty queue
      const finalRel = await gate.releaseSlot(`run_pr_${prs[prs.length - 1]}`);
      assert.equal(finalRel.released, true);
      assert.equal(finalRel.nextRunId, undefined);

      const emptyStatus = await gate.getStatus();
      assert.equal(emptyStatus.activeCount, 0);
      assert.equal(emptyStatus.queueLength, 0);
    });
  });

  // =========================================================================
  // Challenge 3: Full PR Reopen Lifecycle Across Hibernation & Storage
  // =========================================================================
  describe('Challenge 3: Full PR Reopen Lifecycle Across Hibernation & Storage', () => {
    it('executes complete lifecycle: open -> run -> close -> evict -> hibernate -> repoll-rejected -> reopen -> clear-tombstone -> hibernate -> push-commit -> slot-granted', async () => {
      const sharedStorage = new MockDurableObjectState();
      const sharedRunStorage = new MockDurableObjectState();
      const repoFullName = 'calltelemetry/review-yeti';
      const repoKey = repoFullName.toLowerCase();
      const prNumber = 701;
      const secret = 'test-secret-iter4';

      let currentGateInstance = new RepoGateDO(sharedStorage as any, {} as any);
      let currentRunInstance = new ReviewRunDO(sharedRunStorage as any, {} as any);

      const harnessEnv: any = {
        ENVIRONMENT: 'test',
        PARALLEL_MODE: 'shadow',
        PILOT_REPOSITORIES: repoFullName,
        GITHUB_WEBHOOK_SECRET: secret,
        REPO_GATE: {
          idFromName: () => repoKey,
          get: () => ({
            fetch: async (url: string | Request, init?: any) => {
              const req = typeof url === 'string' ? new Request(url, init) : url;
              return currentGateInstance.fetch(req);
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: (name: string) => name,
          get: (id: string) => ({
            fetch: async (url: string | Request, init?: any) => {
              const req = typeof url === 'string' ? new Request(url, init) : url;
              return currentRunInstance.fetch(req);
            },
          }),
        },
        REVIEW_DEBOUNCE_QUEUE: {
          send: async () => ({} as any),
        },
      };

      // -------------------------------------------------------------
      // Step A: PR 701 opened -> commit 1 is granted slot and completes
      // -------------------------------------------------------------
      const run1 = 'run_701_c1';
      const acq1 = await currentGateInstance.acquireSlot(run1, 'sha_c1', prNumber);
      assert.equal(acq1.granted, true, 'Initial commit on opened PR must acquire slot');
      assert.equal(currentGateInstance.getActiveRun(prNumber), run1);

      // Initialize run DO and acquire lease
      await currentRunInstance.initialize({
        runId: run1,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_c1',
        baseSha: 'main',
        installationId: 1,
      });
      const lease1 = await currentRunInstance.acquireWorkerLease('worker-1', 1);
      assert.equal(lease1.ok, true);

      // Run finishes and submits receipt
      const receipt1 = await currentRunInstance.submitReceipt({ status: 'succeeded', verdict: 'success' }, 1);
      assert.equal(receipt1.accepted, true);

      // Release slot
      const rel1 = await currentGateInstance.releaseSlot(run1);
      assert.equal(rel1.released, true);

      // Gate is now idle, but prRunsSeen remembers run_701_c1
      const statusAfterRun1 = await currentGateInstance.getStatus();
      assert.equal(statusAfterRun1.activeCount, 0);
      assert.equal(statusAfterRun1.queueLength, 0);

      // -------------------------------------------------------------
      // Step B: Developer CLOSES PR 701
      // Ingress receives 'closed' webhook
      // -------------------------------------------------------------
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_c1' }, base: { sha: 'main' } },
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
        harnessEnv
      );
      assert.equal(resClose.status, 200);
      const closeData = (await resClose.json()) as any;
      assert.equal(closeData.status, 'cancelled');

      // Verify tombstone is saved to persistent storage
      const storedLatestAfterClose = await sharedStorage.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMapAfterClose = new Map(storedLatestAfterClose);
      assert.equal(
        latestMapAfterClose.get(prNumber),
        '__EVICTED__',
        "Tombstone '__EVICTED__' must be persisted in storage after PR close"
      );

      // -------------------------------------------------------------
      // Step C: Verify stale run re-poll on closed PR is rejected
      // -------------------------------------------------------------
      const staleRepollBeforeRestart = await currentGateInstance.acquireSlot(run1, 'sha_c1', prNumber);
      assert.equal(staleRepollBeforeRestart.granted, false);
      assert.equal(staleRepollBeforeRestart.evicted, true);

      // -------------------------------------------------------------
      // Step D: SIMULATE DO RESTART / HIBERNATION
      // Cold boot from persistent storage
      // -------------------------------------------------------------
      currentGateInstance = new RepoGateDO(sharedStorage as any, {} as any);

      // -------------------------------------------------------------
      // Step E: Verify on restarted DO, stale run is STILL rejected
      // -------------------------------------------------------------
      const staleRepollAfterRestart = await currentGateInstance.acquireSlot(run1, 'sha_c1', prNumber);
      assert.equal(
        staleRepollAfterRestart.granted,
        false,
        'Stale run from closed PR must be rejected after DO restart'
      );
      assert.equal(
        staleRepollAfterRestart.evicted,
        true,
        'Stale run from closed PR must be marked evicted after DO restart'
      );

      // -------------------------------------------------------------
      // Step F: Developer REOPENS PR 701
      // Ingress receives 'reopened' webhook
      // -------------------------------------------------------------
      const bodyReopen = JSON.stringify({
        action: 'reopened',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_c1' }, base: { sha: 'main' } },
      });
      const sigReopen = await signPayload(secret, bodyReopen);
      const resReopen = await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sigReopen,
          },
          body: bodyReopen,
        }),
        harnessEnv
      );
      assert.equal(resReopen.status, 200);
      const reopenData = (await resReopen.json()) as any;
      assert.equal(reopenData.status, 'ignored', 'Reopened event returns ignored status per spec');

      // Verify tombstone '__EVICTED__' is deleted from storage
      const storedLatestAfterReopen = await sharedStorage.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMapAfterReopen = new Map(storedLatestAfterReopen);
      assert.equal(
        latestMapAfterReopen.get(prNumber),
        undefined,
        "Tombstone '__EVICTED__' must be cleared from storage after PR reopen"
      );

      // -------------------------------------------------------------
      // Step G: Stale run re-polling AFTER PR reopen but BEFORE new commit:
      // Must STILL be rejected!
      // -------------------------------------------------------------
      const staleRepollAfterReopen = await currentGateInstance.acquireSlot(run1, 'sha_c1', prNumber);
      assert.equal(
        staleRepollAfterReopen.granted,
        false,
        'Stale run from before closure must STILL be rejected after reopen'
      );
      assert.equal(
        staleRepollAfterReopen.evicted,
        true,
        'Stale run must remain evicted after reopen'
      );

      // -------------------------------------------------------------
      // Step H: SIMULATE ANOTHER DO RESTART / HIBERNATION
      // Cold boot after reopen
      // -------------------------------------------------------------
      currentGateInstance = new RepoGateDO(sharedStorage as any, {} as any);

      // -------------------------------------------------------------
      // Step I: Developer pushes fresh commit 2 to reopened PR!
      // Ingress receives 'synchronize' webhook
      // -------------------------------------------------------------
      let debouncedMessage: DebounceMessagePayload | undefined;
      harnessEnv.REVIEW_DEBOUNCE_QUEUE.send = async (msg: DebounceMessagePayload) => {
        debouncedMessage = msg;
        return {} as any;
      };

      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_c2_fresh' }, base: { sha: 'main' } },
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
        harnessEnv
      );
      assert.equal(resSync.status, 200);
      const syncData = (await resSync.json()) as any;
      assert.equal(syncData.status, 'queued_debounced');
      const run2 = syncData.runId;
      assert.ok(debouncedMessage);
      assert.equal(debouncedMessage!.runId, run2);

      // -------------------------------------------------------------
      // Step J: Debounce quiet window expires -> consumer runs -> acquires slot
      // -------------------------------------------------------------
      const acq2 = await currentGateInstance.acquireSlot(run2, 'sha_c2_fresh', prNumber);
      assert.equal(
        acq2.granted,
        true,
        `Fresh commit on reopened PR MUST be granted slot! Result: ${JSON.stringify(acq2)}`
      );
      assert.equal(
        acq2.evicted,
        undefined,
        'Fresh commit on reopened PR must NOT be marked evicted'
      );
      assert.equal(currentGateInstance.getActiveRun(prNumber), run2);

      // Verify run 2 can acquire lease, heartbeat, and submit receipt
      const run2DOStorage = new MockDurableObjectState();
      const run2DO = new ReviewRunDO(run2DOStorage as any, {} as any);
      await run2DO.initialize({
        runId: run2,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_c2_fresh',
        baseSha: 'main',
        installationId: 1,
      });
      const lease2 = await run2DO.acquireWorkerLease('worker-fresh', 1);
      assert.equal(lease2.ok, true);

      const hb2 = await run2DO.heartbeat('worker-fresh', 1);
      assert.equal(hb2.ok, true);

      const receipt2 = await run2DO.submitReceipt({ status: 'succeeded', verdict: 'success' }, 1);
      assert.equal(receipt2.accepted, true);

      const status2 = await run2DO.getStatus();
      assert.equal(status2.phase, 'Completed');
      assert.equal(status2.isCurrentHead, true);

      // Cleanup
      const rel2 = await currentGateInstance.releaseSlot(run2);
      assert.equal(rel2.released, true);
    });

    it('handles multiple close -> reopen -> close -> reopen churn cycles cleanly', async () => {
      const sharedStorage = new MockDurableObjectState();
      const repoFullName = 'calltelemetry/review-yeti';
      const repoKey = repoFullName.toLowerCase();
      const prNumber = 801;
      const secret = 'test-secret-iter4';

      let gate = new RepoGateDO(sharedStorage as any, {} as any);
      const harnessEnv: any = {
        ENVIRONMENT: 'test',
        PARALLEL_MODE: 'shadow',
        PILOT_REPOSITORIES: repoFullName,
        GITHUB_WEBHOOK_SECRET: secret,
        REPO_GATE: {
          idFromName: () => repoKey,
          get: () => ({
            fetch: async (url: string | Request, init?: any) => {
              const req = typeof url === 'string' ? new Request(url, init) : url;
              return gate.fetch(req);
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run',
          get: () => ({
            fetch: async () => Response.json({ cancelled: true }),
          }),
        },
        REVIEW_DEBOUNCE_QUEUE: {
          send: async () => ({} as any),
        },
      };

      // Perform 3 complete cycles of close -> reopen
      for (let cycle = 1; cycle <= 3; cycle++) {
        // Close PR
        const bodyClose = JSON.stringify({
          action: 'closed',
          repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
          pull_request: { number: prNumber, head: { sha: `sha_c${cycle}` }, base: { sha: 'main' } },
        });
        const sigClose = await signPayload(secret, bodyClose);
        const resClose = await worker.fetch(
          new Request('https://operator.calltelemetry.com/api/webhooks/github', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigClose },
            body: bodyClose,
          }),
          harnessEnv
        );
        assert.equal(resClose.status, 200);

        // Verify tombstone
        const storedAfterClose = await sharedStorage.storage.get<[number, string][]>('latestRunIdByPr');
        assert.equal(new Map(storedAfterClose).get(prNumber), '__EVICTED__');

        // Restart DO
        gate = new RepoGateDO(sharedStorage as any, {} as any);

        // Reopen PR
        const bodyReopen = JSON.stringify({
          action: 'reopened',
          repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
          pull_request: { number: prNumber, head: { sha: `sha_c${cycle}` }, base: { sha: 'main' } },
        });
        const sigReopen = await signPayload(secret, bodyReopen);
        const resReopen = await worker.fetch(
          new Request('https://operator.calltelemetry.com/api/webhooks/github', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigReopen },
            body: bodyReopen,
          }),
          harnessEnv
        );
        assert.equal(resReopen.status, 200);

        // Verify tombstone cleared
        const storedAfterReopen = await sharedStorage.storage.get<[number, string][]>('latestRunIdByPr');
        assert.equal(new Map(storedAfterReopen).get(prNumber), undefined);

        // Restart DO again
        gate = new RepoGateDO(sharedStorage as any, {} as any);
      }

      // After 3 cycles, a new commit arrives and successfully acquires the slot
      const runFinal = 'run_cycle_final';
      const acqFinal = await gate.acquireSlot(runFinal, 'sha_final', prNumber);
      assert.equal(acqFinal.granted, true);
      assert.equal(gate.getActiveRun(prNumber), runFinal);
    });

    it('correctly handles debounced commit arriving after close-and-reopen: rejects stale pre-closure commit', async () => {
      const sharedStorage = new MockDurableObjectState();
      const repoFullName = 'calltelemetry/review-yeti';
      const repoKey = repoFullName.toLowerCase();
      const prNumber = 901;
      const secret = 'test-secret-iter4';

      let gate = new RepoGateDO(sharedStorage as any, {} as any);
      let debouncedMsg: DebounceMessagePayload | undefined;

      const harnessEnv: any = {
        ENVIRONMENT: 'test',
        PARALLEL_MODE: 'shadow',
        PILOT_REPOSITORIES: repoFullName,
        GITHUB_WEBHOOK_SECRET: secret,
        REPO_GATE: {
          idFromName: () => repoKey,
          get: () => ({
            fetch: async (url: string | Request, init?: any) => {
              const req = typeof url === 'string' ? new Request(url, init) : url;
              return gate.fetch(req);
            },
          }),
        },
        REVIEW_RUN: {
          idFromName: () => 'run',
          get: () => ({
            fetch: async () => Response.json({ cancelled: true }),
          }),
        },
        REVIEW_DEBOUNCE_QUEUE: {
          send: async (msg: DebounceMessagePayload) => {
            debouncedMsg = msg;
            return {} as any;
          },
        },
      };

      // 1. Commit A arrives via synchronize (debounced)
      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_pre_close' }, base: { sha: 'main' } },
      });
      const sigSync = await signPayload(secret, bodySync);
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigSync },
          body: bodySync,
        }),
        harnessEnv
      );
      assert.ok(debouncedMsg);
      const staleRunA = debouncedMsg.runId;

      // 2. PR is closed
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_pre_close' }, base: { sha: 'main' } },
      });
      const sigClose = await signPayload(secret, bodyClose);
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigClose },
          body: bodyClose,
        }),
        harnessEnv
      );

      // 3. PR is reopened
      const bodyReopen = JSON.stringify({
        action: 'reopened',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_pre_close' }, base: { sha: 'main' } },
      });
      const sigReopen = await signPayload(secret, bodyReopen);
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigReopen },
          body: bodyReopen,
        }),
        harnessEnv
      );

      // 4. Stale commit A (which was enqueued BEFORE the close) now reaches acquireSlot!
      const acqStaleA = await gate.acquireSlot(staleRunA, 'sha_pre_close', prNumber);
      assert.equal(
        acqStaleA.granted,
        false,
        'Pre-closure commit must NEVER be granted a slot even if PR was reopened'
      );
      assert.equal(
        acqStaleA.evicted,
        true,
        'Pre-closure commit must be marked evicted'
      );

      // 5. A brand new commit B arrives on the reopened PR
      let newDebouncedMsg: DebounceMessagePayload | undefined;
      harnessEnv.REVIEW_DEBOUNCE_QUEUE.send = async (msg: DebounceMessagePayload) => {
        newDebouncedMsg = msg;
        return {} as any;
      };

      const bodySyncB = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: repoFullName, name: 'review-yeti', owner: { login: 'calltelemetry' } },
        pull_request: { number: prNumber, head: { sha: 'sha_post_reopen_commit' }, base: { sha: 'main' } },
      });
      const sigSyncB = await signPayload(secret, bodySyncB);
      await worker.fetch(
        new Request('https://operator.calltelemetry.com/api/webhooks/github', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sigSyncB },
          body: bodySyncB,
        }),
        harnessEnv
      );
      assert.ok(newDebouncedMsg);
      const freshRunB = newDebouncedMsg.runId;

      // Commit B acquires slot successfully
      const acqFreshB = await gate.acquireSlot(freshRunB, 'sha_post_reopen_commit', prNumber);
      assert.equal(
        acqFreshB.granted,
        true,
        'Fresh commit post-reopen must acquire the concurrency slot'
      );
      assert.equal(gate.getActiveRun(prNumber), freshRunB);
    });
  });

  // =========================================================================
  // Challenge 4: Memory & Scale Bounds Under Extended Churn
  // =========================================================================
  describe('Challenge 4: Memory & Scale Bounds Under Extended Churn', () => {
    it('verifies evictedRunIds ring-buffer cap (1000 items) does not drop PR-level stale protection', async () => {
      const state = new MockDurableObjectState();
      const gate = new RepoGateDO(state as any, {} as any);

      // PR 999 receives run_999_old
      await gate.acquireSlot('run_busy_slot', 'sha_busy', 1);
      await gate.acquireSlot('run_999_old', 'sha_999_old', 999);

      // Supersede with run_999_new
      await gate.acquireSlot('run_999_new', 'sha_999_new', 999);

      // Now generate 2000 evictions on other PRs to completely rotate evictedRunIds ring buffer
      for (let i = 1; i <= 2000; i++) {
        const dummyRun = `dummy_run_${i}`;
        await gate.acquireSlot(dummyRun, `sha_dummy_${i}`, 10000 + i);
        await gate.evictQueue({ runId: dummyRun });
      }

      // Check evictedRunIds size in storage: must be capped at <= 1000
      const storedEvicted = await state.storage.get<string[]>('evictedRunIds');
      assert.ok(storedEvicted);
      assert.ok(storedEvicted.length <= 1000, `evictedRunIds must be <= 1000, got ${storedEvicted.length}`);

      // Now run_999_old is NO LONGER in evictedRunIds Set!
      // But because of prRunsSeen and latestRunIdByPr, it MUST STILL BE REJECTED!
      const staleRepoll = await gate.acquireSlot('run_999_old', 'sha_999_old', 999);
      assert.equal(
        staleRepoll.granted,
        false,
        'Stale run must remain rejected even after falling out of the 1000-item evictedRunIds ring buffer'
      );
      assert.equal(
        staleRepoll.evicted,
        true,
        'Stale run must be marked evicted'
      );

      // Release busy slot: run_999_new must be promoted
      const rel = await gate.releaseSlot('run_busy_slot');
      assert.equal(rel.nextRunId, 'run_999_new');
    });
  });
});
