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
  repoGateInstances: Map<string, RepoGateDO>;
  reviewRunInstances: Map<string, ReviewRunDO>;
  queuedDebounceMessages: DebounceMessagePayload[];
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
}

function createHarness(): TestHarness {
  const repoGateInstances = new Map<string, RepoGateDO>();
  const reviewRunInstances = new Map<string, ReviewRunDO>();
  const queuedDebounceMessages: DebounceMessagePayload[] = [];
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];

  const env: any = {
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'shadow',
    OPERATOR_GLOBAL_PASSTHROUGH: 'false',
    PILOT_REPOSITORIES: 'exampleorg/review-yeti,exampleorg/test-repo',
    GITHUB_WEBHOOK_SECRET: 'test-secret-12345',
    DOKS_FALLBACK_URL: undefined, // disabled in test harness to avoid network DNS noise

    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (id: string) => {
        const key = id.toLowerCase();
        if (!repoGateInstances.has(key)) {
          const state = new MockDurableObjectState();
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
    repoGateInstances,
    reviewRunInstances,
    queuedDebounceMessages,
    dispatchedWorkflows,
  };
}

describe('M1 Iteration 2 Adversarial Challenge & Empirical Stress Harness', () => {
  describe('Challenge 1: Rapid Commit Bursts Under High Contention (< 3s SLA)', () => {
    it('cancels active run within < 3s under a burst of 50 concurrent synchronize webhook requests', async () => {
      const harness = createHarness();
      const secret = 'test-secret-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 77;

      // 1. Setup an active running job on PR 77
      const activeRunId = 'run_active_pr77';
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId, headSha: 'sha_base_pr77', prNumber }),
      });

      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(activeRunId));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId,
          owner: 'exampleorg',
          repo: 'review-yeti',
          prNumber,
          headSha: 'sha_base_pr77',
          baseSha: 'main',
        }),
      });
      await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker-initial', epoch: 1 }),
      });

      // Verify it is active and epoch is 1
      const activeStatusBefore = await (await runDO.fetch('http://do/status')).json() as any;
      assert.equal(activeStatusBefore.phase, 'Running');
      assert.equal(activeStatusBefore.fencingEpoch, 1);
      assert.equal(activeStatusBefore.isCurrentHead, true);

      // 2. Fire 50 concurrent synchronize webhooks simulating rapid commit burst
      const burstSize = 50;
      const startTime = performance.now();

      const requests = Array.from({ length: burstSize }, async (_, idx) => {
        const body = JSON.stringify({
          action: 'synchronize',
          repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
          pull_request: { number: prNumber, head: { sha: `commit_sha_${idx}` }, base: { sha: 'main' } },
        });
        const sig = await signPayload(secret, body);
        const reqStart = performance.now();
        const res = await worker.fetch(
          new Request('https://operator.example.com/api/webhooks/github', {
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
        const reqDuration = performance.now() - reqStart;
        assert.equal(res.status, 200, `Synchronize request ${idx} failed with status ${res.status}`);
        const data = (await res.json()) as any;
        return { idx, reqDuration, data };
      });

      const results = await Promise.all(requests);
      const totalElapsed = performance.now() - startTime;

      // Assert SLA: Total burst duration and individual request durations MUST be < 3000ms
      assert.ok(
        totalElapsed < 3000,
        `Total 50-commit burst took ${totalElapsed.toFixed(2)}ms, exceeding 3000ms SLA`
      );

      const maxReqDuration = Math.max(...results.map((r) => r.reqDuration));
      assert.ok(
        maxReqDuration < 3000,
        `Max single synchronize latency was ${maxReqDuration.toFixed(2)}ms, exceeding 3000ms SLA`
      );

      // Verify that the active run is cancelled, epoch incremented, and cannot be updated
      const activeStatusAfter = await (await runDO.fetch('http://do/status')).json() as any;
      assert.equal(activeStatusAfter.phase, 'Cancelled');
      assert.ok(activeStatusAfter.fencingEpoch >= 2, 'Fencing epoch must be bumped');
      assert.equal(activeStatusAfter.isCurrentHead, false);

      // Assert worker heartbeat and receipt are rejected
      const staleHeartbeat = await (await runDO.fetch('http://do/lease/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker-initial', epoch: 1 }),
      })).json() as any;
      assert.equal(staleHeartbeat.ok, false);

      const staleReceipt = await (await runDO.fetch('http://do/receipt', {
        method: 'POST',
        body: JSON.stringify({ receipt: { verdict: 'success' }, epoch: 1 }),
      })).json() as any;
      assert.equal(staleReceipt.accepted, false);

      // Assert all 50 commits were debounced into the queue
      assert.equal(harness.queuedDebounceMessages.length, burstSize);
    });
  });

  describe('Challenge 2: Stale Commits Re-polling Can NEVER Evict Newer Commits in RepoGateDO', () => {
    it('preserves newer commit position when multiple older commits re-poll in random order', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Occupy active slot
      await gate.acquireSlot('run_active', 'sha_active', 10);

      // Commit 1 arrives for PR 20
      const c1 = await gate.acquireSlot('run_commit_1', 'sha_1', 20);
      assert.equal(c1.granted, false);
      assert.equal(c1.queuePosition, 1);

      // Commit 2 arrives for PR 20 (supersedes Commit 1)
      const c2 = await gate.acquireSlot('run_commit_2', 'sha_2', 20);
      assert.equal(c2.granted, false);
      assert.equal(c2.queuePosition, 1, 'Commit 2 replaces Commit 1 at position 1');

      // Commit 3 arrives for PR 20 (supersedes Commit 2)
      const c3 = await gate.acquireSlot('run_commit_3', 'sha_3', 20);
      assert.equal(c3.granted, false);
      assert.equal(c3.queuePosition, 1, 'Commit 3 replaces Commit 2 at position 1');

      // Now stale commits (Commit 1 and Commit 2) wake up and re-poll 100 times in interleaved order
      for (let i = 0; i < 100; i++) {
        const stale1 = await gate.acquireSlot('run_commit_1', 'sha_1', 20);
        assert.equal(stale1.granted, false, 'Commit 1 must be rejected');

        const stale2 = await gate.acquireSlot('run_commit_2', 'sha_2', 20);
        assert.equal(stale2.granted, false, 'Commit 2 must be rejected');

        // Valid commit 3 also re-polls (in-place update)
        const valid3 = await gate.acquireSlot('run_commit_3', 'sha_3', 20);
        assert.equal(valid3.granted, false);
        assert.equal(valid3.queuePosition, 1, 'Commit 3 must maintain position 1');
      }

      // Check final queue state: MUST only contain Commit 3
      const status = await gate.getStatus();
      assert.equal(status.queueLength, 1);

      // When active run releases, Commit 3 must be promoted
      const rel = await gate.releaseSlot('run_active');
      assert.equal(rel.released, true);
      assert.equal(rel.nextRunId, 'run_commit_3');
      assert.equal(gate.getActiveRun(20), 'run_commit_3');
    });

    it('preserves multi-PR FIFO queue order when stale commits from various PRs re-poll under contention', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Occupy active slot
      await gate.acquireSlot('run_active', 'sha_active', 1);

      // PR 100: Commit 100A arrives
      await gate.acquireSlot('run_100_A', 'sha_100_A', 100);
      // PR 200: Commit 200A arrives
      await gate.acquireSlot('run_200_A', 'sha_200_A', 200);
      // PR 300: Commit 300A arrives
      await gate.acquireSlot('run_300_A', 'sha_300_A', 300);

      // Queue order: [100A, 200A, 300A]
      let status = await gate.getStatus();
      assert.equal(status.queueLength, 3);

      // Now PR 200 pushes Commit 200B (supersedes 200A, moves to tail: [100A, 300A, 200B])
      await gate.acquireSlot('run_200_B', 'sha_200_B', 200);

      // PR 100 pushes Commit 100B (supersedes 100A, moves to tail: [300A, 200B, 100B])
      await gate.acquireSlot('run_100_B', 'sha_100_B', 100);

      // Now stale commits 100A and 200A re-poll
      const repoll100A = await gate.acquireSlot('run_100_A', 'sha_100_A', 100);
      assert.equal(repoll100A.granted, false);

      const repoll200A = await gate.acquireSlot('run_200_A', 'sha_200_A', 200);
      assert.equal(repoll200A.granted, false);

      // Verify the promotion sequence as slots are released
      const r1 = await gate.releaseSlot('run_active');
      assert.equal(r1.nextRunId, 'run_300_A', 'First promoted must be 300A');

      const r2 = await gate.releaseSlot('run_300_A');
      assert.equal(r2.nextRunId, 'run_200_B', 'Second promoted must be 200B');

      const r3 = await gate.releaseSlot('run_200_B');
      assert.equal(r3.nextRunId, 'run_100_B', 'Third promoted must be 100B');

      const r4 = await gate.releaseSlot('run_100_B');
      assert.equal(r4.nextRunId, undefined, 'Queue must be empty');

      status = await gate.getStatus();
      assert.equal(status.activeCount, 0);
      assert.equal(status.queueLength, 0);
    });

    it('stress-tests 1000-eviction capacity boundary to verify whether older commit can evict newer commit', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Active job
      await gate.acquireSlot('run_active', 'sha_active', 1);

      // Commit 1 on PR 500
      await gate.acquireSlot('run_500_v1', 'sha_1', 500);

      // Commit 2 on PR 500 (supersedes Commit 1)
      await gate.acquireSlot('run_500_v2', 'sha_2', 500);

      // Now create and evict 1005 other runs to test the 1000-evictedRunIds LRU cap
      for (let i = 1; i <= 1005; i++) {
        // Enqueue and evict via evictQueue
        const dummyRunId = `run_dummy_${i}`;
        const dummyPr = 10000 + i;
        await gate.acquireSlot(dummyRunId, 'dummy_sha', dummyPr);
        await gate.evictQueue({ runId: dummyRunId });
      }

      // At this point, more than 1000 runs have been evicted.
      // Has run_500_v1 been purged from evictedRunIds?
      // Let's test what happens when run_500_v1 re-polls acquireSlot:
      const repollResult = await gate.acquireSlot('run_500_v1', 'sha_1', 500);

      const status = await gate.getStatus();
      const storedQueue = ((await state.storage.get('queue')) as any[]) || [];

      // VULNERABILITY ASSERTION / CHALLENGE PROBE:
      // If run_500_v1 was purged from evictedRunIds, its re-poll treated it as a NEW run
      // and evicted run_500_v2!
      // We empirically record whether run_500_v2 is preserved or evicted:
      const v2StillInQueue = storedQueue.some((item) => item.runId === 'run_500_v2');
      const v1InQueue = storedQueue.some((item) => item.runId === 'run_500_v1');

      console.log('--- 1000-Eviction Boundary Test ---');
      console.log('Repoll result for stale run_500_v1:', repollResult);
      console.log('Stored queue:', storedQueue);
      console.log('Is v2 still in queue?', v2StillInQueue);
      console.log('Is v1 resurrected into queue?', v1InQueue);

      // If repollResult.granted is true or v1 replaced v2, this reveals a boundary leak
      assert.ok(
        v2StillInQueue && !v1InQueue,
        `Vulnerability Confirmed: Stale run resurrected after 1000 evictions! v2InQueue=${v2StillInQueue}, v1InQueue=${v1InQueue}`
      );
    });
  });

  describe('Challenge 3: Cancelled Workflows Terminate Polling Loop Immediately and Do Not Resurrect', () => {
    it('terminates polling loop on attempt 1 when ReviewRunDO is cancelled during queue wait', async () => {
      const harness = createHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);

      // Occupy slot in RepoGateDO
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName('exampleorg/review-yeti'));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'prior_active_run', headSha: 'prior_sha' }),
      });

      const spec: ReviewRunSpec = {
        runId: 'run_wf_cancel_probe',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber: 88,
        headSha: 'head88',
        baseSha: 'main',
        installationId: 500,
      };

      const executedStepNames: string[] = [];
      let pollAttempts = 0;

      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          executedStepNames.push(name);
          if (name.startsWith('poll-slot-')) {
            pollAttempts++;
            // Cancel run during first poll attempt
            const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(spec.runId));
            await runDO.fetch('http://do/cancel', {
              method: 'POST',
              body: JSON.stringify({ reason: 'superseded_by_commit' }),
            });
          }
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {
          executedStepNames.push(name);
        },
      };

      await assert.rejects(
        async () => workflow.run({ payload: spec }, mockStep as any),
        /Workflow cancelled while waiting for concurrency slot/
      );

      // Assertions:
      // 1. Terminated on attempt 1
      assert.equal(pollAttempts, 1, `Polling loop should have terminated on attempt 1, but ran ${pollAttempts} times`);
      // 2. dispatch-container was NEVER called
      assert.ok(!executedStepNames.includes('dispatch-container'));
      assert.equal(runner.dispatched.length, 0);
      // 3. cleanup-and-release WAS called
      assert.ok(executedStepNames.includes('cleanup-and-release'));
      // 4. RepoGateDO queue was cleaned up
      const gateStatus = await (await repoGate.fetch('http://do/status')).json() as any;
      assert.equal(gateStatus.queueLength, 0);
    });

    it('investigates whether a queued workflow waiting in RepoGateDO loop terminates when PR is closed via webhook', async () => {
      const harness = createHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 95;

      // PR 94 is occupying the active slot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr94_active', headSha: 'sha94', prNumber: 94 }),
      });

      const spec: ReviewRunSpec = {
        runId: 'run_pr95_queued',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha95',
        baseSha: 'main',
        installationId: 501,
      };

      let pollAttempts = 0;
      const executedSteps: string[] = [];

      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          executedSteps.push(name);
          if (name === 'poll-slot-1') {
            pollAttempts++;
            // During wait, GitHub fires PR closed webhook for PR 95!
            const body = JSON.stringify({
              action: 'closed',
              repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
              pull_request: { number: prNumber, head: { sha: 'sha95' }, base: { sha: 'main' } },
            });
            const sig = await signPayload(secret, body);
            const res = await worker.fetch(
              new Request('https://operator.example.com/api/webhooks/github', {
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
            assert.equal(res.status, 200);
          } else if (name.startsWith('poll-slot-')) {
            pollAttempts++;
            if (pollAttempts >= 5) {
              // Safety breaker to stop infinite loop during test execution
              throw new Error('TEST_BREAKER: Workflow looped 5 times without terminating');
            }
          }
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {
          executedSteps.push(name);
        },
      };

      // Let's see what happens to workflow.run!
      let workflowError: any = null;
      try {
        await workflow.run({ payload: spec }, mockStep as any);
      } catch (err) {
        workflowError = err;
      }

      console.log('--- PR Closed While Queued Test ---');
      console.log('Total poll attempts executed:', pollAttempts);
      console.log('Workflow error thrown:', workflowError?.message);

      // Check ReviewRunDO status
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(spec.runId));
      const runStatus = await (await runDO.fetch('http://do/status')).json() as any;
      console.log('ReviewRunDO status for queued run:', runStatus);

      // CHALLENGE ANALYSIS:
      // Does worker.ts cancel the queued run when closed arrives?
      // In worker.ts line 309: activeRunId = await getActiveRunForPR(env, repoKey, 95);
      // Since 95 was queued (not active), activeRunId was null!
      // So cancelRun was NOT called on run_pr95_queued!
      // RepoGateDO evicted run_pr95_queued via evictQueuedRunsForPR.
      // But ReviewRunDO remained Pending!
      // As a result, when poll-slot-1 called acquireSlot, it received { granted: false },
      // and continued looping until our safety breaker!
      assert.ok(
        pollAttempts <= 2,
        `Vulnerability Confirmed: Queued workflow does NOT terminate immediately when PR is closed! Polled ${pollAttempts} times. Error: ${workflowError?.message}`
      );
    });

    it('investigates whether a queued commit is superseded when synchronize webhook arrives', async () => {
      const harness = createHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 96;

      // PR 94 is occupying the active slot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr94_active', headSha: 'sha94', prNumber: 94 }),
      });

      // Commit 1 on PR 96 arrives and enters queue
      const specV1: ReviewRunSpec = {
        runId: 'run_pr96_v1',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha96_v1',
        baseSha: 'main',
        installationId: 502,
      };

      let synchronizeFired = false;
      const mockStepV1 = {
        async do(name: string, arg2: any, arg3?: any) {
          if (name === 'poll-slot-1') {
            // Check state on first poll
          }
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {
          if (name === 'wait-for-slot-1' && !synchronizeFired) {
            synchronizeFired = true;
            // Now developer pushes Commit 2 to PR 96 (synchronize webhook arrives)
            const body = JSON.stringify({
              action: 'synchronize',
              repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
              pull_request: { number: prNumber, head: { sha: 'sha96_v2' }, base: { sha: 'main' } },
            });
            const sig = await signPayload(secret, body);
            const res = await worker.fetch(
              new Request('https://operator.example.com/api/webhooks/github', {
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
            assert.equal(res.status, 200);

            // Now PR 94 finishes and releases slot!
            await repoGate.fetch('http://do/release', {
              method: 'POST',
              body: JSON.stringify({ runId: 'run_pr94_active' }),
            });
          }
        },
      };

      // Let workflow run
      let result: any = null;
      try {
        result = await workflow.run({ payload: specV1 }, mockStepV1 as any);
      } catch (err: any) {
        result = { runId: specV1.runId, status: 'cancelled', error: err.message };
      }

      console.log('--- Synchronize While Queued Result ---');
      console.log('V1 Workflow run result:', result);

      // Inspect runner: Was the container dispatched for V1?
      console.log('Runner dispatched jobs count:', runner.dispatched.length);
      if (runner.dispatched.length > 0) {
        console.log('Dispatched job details:', runner.dispatched[0]);
      }

      // CHALLENGE ASSERTION:
      // Since Commit 2 arrived while V1 was waiting in queue, V1 is a superseded stale commit.
      // Did V1 dispatch a container anyway?
      assert.equal(
        runner.dispatched.length,
        0,
        `Vulnerability Confirmed: Stale commit V1 dispatched container after being superseded by Commit 2! HeadSha: ${runner.dispatched[0]?.headSha}`
      );
    });
  });
});
