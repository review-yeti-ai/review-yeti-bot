import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockContainerRunner } from '../src/runners/containerRunner.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from '../src/types.js';

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
  repoGateStates: Map<string, MockDurableObjectState>;
  reviewRunInstances: Map<string, ReviewRunDO>;
  reviewRunStates: Map<string, MockDurableObjectState>;
  queuedDebounceMessages: DebounceMessagePayload[];
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  rebootRepoGate: (name: string) => RepoGateDO;
}

function createDeepHarness(): TestHarness {
  const repoGateInstances = new Map<string, RepoGateDO>();
  const repoGateStates = new Map<string, MockDurableObjectState>();
  const reviewRunInstances = new Map<string, ReviewRunDO>();
  const reviewRunStates = new Map<string, MockDurableObjectState>();
  const queuedDebounceMessages: DebounceMessagePayload[] = [];
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];

  const env: any = {
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'shadow',
    PILOT_REPOSITORIES: 'exampleorg/review-yeti,exampleorg/test-repo',
    GITHUB_WEBHOOK_SECRET: 'test-secret-deep-12345',
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

  const rebootRepoGate = (name: string): RepoGateDO => {
    const key = name.toLowerCase();
    const existingState = repoGateStates.get(key);
    if (!existingState) {
      throw new Error(`Cannot reboot non-existent RepoGateDO: ${name}`);
    }
    // Instantiate brand new RepoGateDO instance with the SAME storage to simulate DO restart
    const rebootedGate = new RepoGateDO(existingState as any, env);
    repoGateInstances.set(key, rebootedGate);
    return rebootedGate;
  };

  return {
    env,
    repoGateInstances,
    repoGateStates,
    reviewRunInstances,
    reviewRunStates,
    queuedDebounceMessages,
    dispatchedWorkflows,
    rebootRepoGate,
  };
}

describe('M1 Iteration 3 Deep Empirical Challenger Verification', () => {
  describe('Vulnerability 1: >1,000 Evictions Integrity & Non-Resurrection', () => {
    it('prevents stale commit resurrection after 2,500 evictions and DO persistence reboot', async () => {
      const harness = createDeepHarness();
      const repoKey = 'exampleorg/review-yeti';
      const gate = harness.repoGateInstances.get(repoKey) ||
        (harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey)), harness.repoGateInstances.get(repoKey)!);

      // 1. Occupy active slot
      const rActive = await gate.acquireSlot('run_active', 'sha_active', 10);
      assert.equal(rActive.granted, true);

      // 2. Commit 1 on PR 700 enters queue
      const rC1 = await gate.acquireSlot('run_700_v1', 'sha_700_v1', 700);
      assert.equal(rC1.granted, false);
      assert.equal(rC1.queuePosition, 1);

      // 3. Commit 2 on PR 700 arrives and supersedes Commit 1
      const rC2 = await gate.acquireSlot('run_700_v2', 'sha_700_v2', 700);
      assert.equal(rC2.granted, false);
      assert.equal(rC2.queuePosition, 1);

      // 4. Perform 2,500 evictions across 2,500 separate PRs
      const evictionCount = 2500;
      for (let i = 1; i <= evictionCount; i++) {
        const dummyRunId = `run_flood_${i}`;
        const dummyPr = 20000 + i;
        await gate.acquireSlot(dummyRunId, `sha_flood_${i}`, dummyPr);
        await gate.evictQueue({ runId: dummyRunId, prNumber: dummyPr });
      }

      // 5. Simulate Durable Object restart (unloaded from RAM, re-hydrated from storage)
      const rebootedGate = harness.rebootRepoGate(repoKey);

      // 6. Stale Commit 1 re-polls acquireSlot on the rebooted DO
      const repollV1 = await rebootedGate.acquireSlot('run_700_v1', 'sha_700_v1', 700);
      assert.equal(repollV1.granted, false);
      assert.equal(repollV1.evicted, true, 'Stale Commit 1 must be flagged as evicted');

      // 7. Verify queue state: Commit 2 MUST still be at position 1, Commit 1 MUST NOT be in queue
      const status = await rebootedGate.getStatus();
      assert.equal(status.queueLength, 1);

      // 8. Commit 2 re-polls: must maintain position 1
      const repollV2 = await rebootedGate.acquireSlot('run_700_v2', 'sha_700_v2', 700);
      assert.equal(repollV2.granted, false);
      assert.equal(repollV2.queuePosition, 1);

      // 9. When active run releases, Commit 2 is promoted to active
      const rel1 = await rebootedGate.releaseSlot('run_active');
      assert.equal(rel1.released, true);
      assert.equal(rel1.nextRunId, 'run_700_v2');

      // 10. When Commit 2 completes and releases slot (slot is now free)
      const rel2 = await rebootedGate.releaseSlot('run_700_v2');
      assert.equal(rel2.released, true);
      assert.equal(rel2.nextRunId, undefined);

      // 11. Stale Commit 1 attempts to re-poll when slot is completely free!
      const staleFreeSlotAttempt = await rebootedGate.acquireSlot('run_700_v1', 'sha_700_v1', 700);
      assert.equal(staleFreeSlotAttempt.granted, false, 'Stale run must NEVER acquire even an empty/free slot');
      assert.equal(staleFreeSlotAttempt.evicted, true);

      // 12. New Commit 3 on PR 700 arrives and acquires the free slot successfully
      const c3 = await rebootedGate.acquireSlot('run_700_v3', 'sha_700_v3', 700);
      assert.equal(c3.granted, true, 'Fresh commit on PR 700 must be granted free slot');
    });

    it('handles multi-commit churn (5 commits on same PR) across 1,500 evictions with interleaved re-polls', async () => {
      const harness = createDeepHarness();
      const repoKey = 'exampleorg/review-yeti';
      const gate = harness.repoGateInstances.get(repoKey) ||
        (harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey)), harness.repoGateInstances.get(repoKey)!);

      await gate.acquireSlot('run_busy', 'sha_busy', 1);

      const pr = 888;
      // Arrive v1, v2, v3, v4, v5 sequentially
      for (let v = 1; v <= 5; v++) {
        await gate.acquireSlot(`run_888_v${v}`, `sha_888_v${v}`, pr);
      }

      // Generate 1,500 evictions on other PRs
      for (let i = 1; i <= 1500; i++) {
        const dummyId = `churn_${i}`;
        await gate.acquireSlot(dummyId, `sha_${i}`, 50000 + i);
        await gate.evictQueue({ runId: dummyId });
      }

      // Interleave 200 re-polls across v1, v2, v3, v4 in randomized order
      const staleRuns = ['run_888_v1', 'run_888_v2', 'run_888_v3', 'run_888_v4'];
      for (let i = 0; i < 200; i++) {
        const pick = staleRuns[Math.floor(Math.random() * staleRuns.length)];
        const res = await gate.acquireSlot(pick, 'stale_sha', pr);
        assert.equal(res.granted, false);
        assert.equal(res.evicted, true);
      }

      // v5 re-polls: must still be at position 1
      const v5Res = await gate.acquireSlot('run_888_v5', 'sha_888_v5', pr);
      assert.equal(v5Res.granted, false);
      assert.equal(v5Res.queuePosition, 1);

      // Release active slot: v5 must be promoted
      const rel = await gate.releaseSlot('run_busy');
      assert.equal(rel.nextRunId, 'run_888_v5');
    });

    it('enforces permanent rejection after PR eviction (__EVICTED__) even after 1,200 external evictions', async () => {
      const harness = createDeepHarness();
      const repoKey = 'exampleorg/review-yeti';
      const gate = harness.repoGateInstances.get(repoKey) ||
        (harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey)), harness.repoGateInstances.get(repoKey)!);

      await gate.acquireSlot('run_active', 'sha_active', 100);
      await gate.acquireSlot('run_pr900_v1', 'sha_v1', 900);

      // Evict PR 900 completely (e.g. PR closed or converted to draft)
      const evictRes = await gate.evictQueue({ prNumber: 900 });
      assert.equal(evictRes.evicted, true);
      assert.deepEqual(evictRes.evictedRunIds, ['run_pr900_v1']);

      // 1,200 evictions happen across system
      for (let i = 1; i <= 1200; i++) {
        const id = `ev_${i}`;
        await gate.acquireSlot(id, `sha_${i}`, 70000 + i);
        await gate.evictQueue({ runId: id });
      }

      // Stale v1 re-polls: MUST be rejected with evicted: true
      const repollV1 = await gate.acquireSlot('run_pr900_v1', 'sha_v1', 900);
      assert.equal(repollV1.granted, false);
      assert.equal(repollV1.evicted, true);

      // PR is re-opened: clear eviction tombstone and brand new commit v2 arrives
      await gate.clearEviction(900);
      const newV2 = await gate.acquireSlot('run_pr900_v2', 'sha_v2', 900);
      assert.equal(newV2.granted, false);
      assert.equal(newV2.queuePosition, 1, 'Fresh commit on re-opened PR must be enqueued');

      // Stale v1 re-polls again: MUST still be rejected!
      const repollV1Again = await gate.acquireSlot('run_pr900_v1', 'sha_v1', 900);
      assert.equal(repollV1Again.granted, false);
      assert.equal(repollV1Again.evicted, true);
    });

    it('probes whether evictQueue({ prNumber }) persists __EVICTED__ to storage when queue is currently empty', async () => {
      const harness = createDeepHarness();
      const repoKey = 'exampleorg/review-yeti';
      const gate = harness.repoGateInstances.get(repoKey) ||
        (harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey)), harness.repoGateInstances.get(repoKey)!);

      // PR 950 had run_950_v1 which completed and released slot
      await gate.acquireSlot('run_950_v1', 'sha_950_v1', 950);
      await gate.releaseSlot('run_950_v1');

      // PR 950 is now closed: worker.ts calls evictQueuedRunsForPR(950)
      const evictRes = await gate.evictQueue({ prNumber: 950 });

      // Check whether storage was updated:
      const sharedState = harness.repoGateStates.get(repoKey)!;
      const storedLatest = await sharedState.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMap = new Map(storedLatest);
      const persistedValue = latestMap.get(950);

      // Reboot the DO from storage
      const rebootedGate = harness.rebootRepoGate(repoKey);

      // Now run_950_v1 wakes up / re-polls:
      const repollRes = await rebootedGate.acquireSlot('run_950_v1', 'sha_950_v1', 950);

      // Assert that run_950_v1 was not resurrected into a free slot:
      assert.equal(
        persistedValue,
        '__EVICTED__',
        `Vulnerability Confirmed: evictQueue({ prNumber: 950 }) did not persist '__EVICTED__' to DO storage when queue was empty! Stored: ${persistedValue}`
      );
      assert.equal(
        repollRes.granted,
        false,
        'Stale run from closed PR must NOT be granted concurrency slot after DO restart!'
      );
    });
  });

  describe('Vulnerability 2: synchronize Arrives While Commit is Queued', () => {
    it('cancels and evicts queued prior commit, completely preventing runner dispatch', async () => {
      const harness = createDeepHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-deep-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 601;

      // Slot is occupied by active run
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_active_600', headSha: 'sha_600', prNumber: 600 }),
      });

      const specV1: ReviewRunSpec = {
        runId: 'run_601_v1',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_601_v1',
        baseSha: 'main',
        installationId: 801,
      };

      let syncWebhookFired = false;
      let syncWebhookResult: any = null;

      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {
          if (name === 'wait-for-slot-1' && !syncWebhookFired) {
            syncWebhookFired = true;
            // Webhook synchronize arrives for PR 601 while v1 is waiting
            const body = JSON.stringify({
              action: 'synchronize',
              repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
              pull_request: { number: prNumber, head: { sha: 'sha_601_v2' }, base: { sha: 'main' } },
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
            syncWebhookResult = await res.json();

            // Active run releases slot
            await repoGate.fetch('http://do/release', {
              method: 'POST',
              body: JSON.stringify({ runId: 'run_active_600' }),
            });
          }
        },
      };

      let workflowError: any = null;
      try {
        await workflow.run({ payload: specV1 }, mockStep as any);
      } catch (err: any) {
        workflowError = err;
      }

      // Assertions:
      // 1. Webhook reported superseded run ID
      assert.ok(syncWebhookResult.supersededRunIds.includes('run_601_v1'));

      // 2. Workflow rejected with cancellation
      assert.ok(workflowError, 'Workflow must throw cancellation error');
      assert.match(workflowError.message, /Workflow cancelled/);

      // 3. Runner was NEVER dispatched for v1
      assert.equal(runner.dispatched.length, 0, 'Container runner MUST NEVER be dispatched for superseded commit');

      // 4. ReviewRunDO state is Cancelled with fencingEpoch bumped
      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(specV1.runId));
      const status = await (await runDO.fetch('http://do/status')).json() as any;
      assert.equal(status.phase, 'Cancelled');
      assert.equal(status.cancelRequested, true);
      assert.equal(status.cancelReason, 'superseded_by_commit');
      assert.ok(status.fencingEpoch >= 2);

      // 5. Debounce queue received message for v2
      assert.equal(harness.queuedDebounceMessages.length, 1);
      assert.equal(harness.queuedDebounceMessages[0].headSha, 'sha_601_v2');
    });

    it('handles burst of 5 synchronize events while a commit is queued, cancelling all intermediate runs', async () => {
      const harness = createDeepHarness();
      const runner = new MockContainerRunner();
      const secret = 'test-secret-deep-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 602;

      // Occupy slot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_busy_602', headSha: 'sha_busy', prNumber: 600 }),
      });

      // Commit 1 enters queue
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_602_v1', headSha: 'sha_602_v1', prNumber }),
      });

      // Initialize run 602_v1 in ReviewRunDO
      const runDO1 = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName('run_602_v1'));
      await runDO1.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_602_v1',
          owner: 'exampleorg',
          repo: 'review-yeti',
          prNumber,
          headSha: 'sha_602_v1',
          baseSha: 'main',
        }),
      });

      // 5 synchronize events burst in concurrently
      const burst = [2, 3, 4, 5, 6].map(async (v) => {
        const body = JSON.stringify({
          action: 'synchronize',
          repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
          pull_request: { number: prNumber, head: { sha: `sha_602_v${v}` }, base: { sha: 'main' } },
        });
        const sig = await signPayload(secret, body);
        return worker.fetch(
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
      });

      const responses = await Promise.all(burst);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      // Check ReviewRunDO of run_602_v1
      const st1 = await (await runDO1.fetch('http://do/status')).json() as any;
      assert.equal(st1.phase, 'Cancelled');
      assert.equal(st1.cancelRequested, true);
      assert.ok(st1.fencingEpoch >= 2);

      // Check RepoGateDO queue: run_602_v1 must NOT be in queue
      const gateStatus = await (await repoGate.fetch('http://do/status')).json() as any;
      assert.equal(gateStatus.queueLength, 0);
    });
  });

  describe('Vulnerability 3: PR closed or converted_to_draft while Queued Terminates Immediately (<= 2 attempts)', () => {
    it('terminates in <= 2 attempts when PR is closed while queued', async () => {
      const harness = createDeepHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-deep-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 701;

      // Occupy slot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_active_pr', headSha: 'sha_act', prNumber: 55 }),
      });

      const spec: ReviewRunSpec = {
        runId: 'run_701_queued',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_701',
        baseSha: 'main',
        installationId: 701,
      };

      let pollAttempts = 0;
      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          if (name.startsWith('poll-slot-')) {
            pollAttempts++;
            if (pollAttempts === 1) {
              // Fire PR closed webhook during first poll
              const body = JSON.stringify({
                action: 'closed',
                repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
                pull_request: { number: prNumber, head: { sha: 'sha_701' }, base: { sha: 'main' } },
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
            }
          }
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {},
      };

      let thrownError: any = null;
      try {
        await workflow.run({ payload: spec }, mockStep as any);
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Workflow must throw');
      assert.ok(
        pollAttempts <= 2,
        `Workflow must terminate in <= 2 attempts, but took ${pollAttempts}`
      );
      assert.equal(runner.dispatched.length, 0);

      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(spec.runId));
      const st = await (await runDO.fetch('http://do/status')).json() as any;
      assert.equal(st.phase, 'Cancelled');
      assert.equal(st.cancelReason, 'pr_closed');
    });

    it('terminates in <= 2 attempts when PR is converted_to_draft while queued', async () => {
      const harness = createDeepHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-deep-12345';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 702;

      // Occupy slot
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_active_pr', headSha: 'sha_act', prNumber: 55 }),
      });

      const spec: ReviewRunSpec = {
        runId: 'run_702_queued',
        owner: 'exampleorg',
        repo: 'review-yeti',
        prNumber,
        headSha: 'sha_702',
        baseSha: 'main',
        installationId: 702,
      };

      let pollAttempts = 0;
      const mockStep = {
        async do(name: string, arg2: any, arg3?: any) {
          if (name.startsWith('poll-slot-')) {
            pollAttempts++;
            if (pollAttempts === 1) {
              // Fire PR converted_to_draft webhook during first poll
              const body = JSON.stringify({
                action: 'converted_to_draft',
                repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
                pull_request: { number: prNumber, head: { sha: 'sha_702' }, base: { sha: 'main' } },
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
            }
          }
          const fn = typeof arg2 === 'function' ? arg2 : arg3;
          return fn();
        },
        async sleep(name: string) {},
      };

      let thrownError: any = null;
      try {
        await workflow.run({ payload: spec }, mockStep as any);
      } catch (err: any) {
        thrownError = err;
      }

      assert.ok(thrownError, 'Workflow must throw');
      assert.ok(
        pollAttempts <= 2,
        `Workflow must terminate in <= 2 attempts, but took ${pollAttempts}`
      );
      assert.equal(runner.dispatched.length, 0);

      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(spec.runId));
      const st = await (await runDO.fetch('http://do/status')).json() as any;
      assert.equal(st.phase, 'Cancelled');
      assert.equal(st.cancelReason, 'pr_converted_to_draft');
    });

    it('properly promotes subsequent queued PR when a prior queued PR is closed', async () => {
      const harness = createDeepHarness();
      const secret = 'test-secret-deep-12345';
      const repoKey = 'exampleorg/review-yeti';

      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // Active PR 100
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr100', headSha: 'sha100', prNumber: 100 }),
      });

      // Queued PR 200 (position 1)
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr200', headSha: 'sha200', prNumber: 200 }),
      });

      // Queued PR 300 (position 2)
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr300', headSha: 'sha300', prNumber: 300 }),
      });

      // Check queue length = 2
      let gateStatus = await (await repoGate.fetch('http://do/status')).json() as any;
      assert.equal(gateStatus.queueLength, 2);

      // PR 200 is closed via webhook!
      const body = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
        pull_request: { number: 200, head: { sha: 'sha200' }, base: { sha: 'main' } },
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

      // Queue length should now be 1 (only PR 300 left)
      gateStatus = await (await repoGate.fetch('http://do/status')).json() as any;
      assert.equal(gateStatus.queueLength, 1);

      // Active PR 100 completes and releases slot
      const rel = await (await repoGate.fetch('http://do/release', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_pr100' }),
      })).json() as any;

      assert.equal(rel.released, true);
      // Next promoted run MUST be PR 300 (PR 200 was cleanly bypassed)
      assert.equal(rel.nextRunId, 'run_pr300');
    });
  });
});
