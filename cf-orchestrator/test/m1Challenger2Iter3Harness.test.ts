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
    PILOT_REPOSITORIES: 'exampleorg/review-yeti,exampleorg/test-repo',
    GITHUB_WEBHOOK_SECRET: 'test-secret-iter3',
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

describe('M1 Iteration 3 Adversarial Challenge & Empirical Verification Harness', () => {
  // =========================================================================
  // Mission Area 1: Rapid-fire webhook bursts (synchronize, closed, reopened)
  // =========================================================================
  describe('Mission Area 1: Rapid-Fire Webhook Bursts (synchronize, closed, reopened)', () => {
    it('handles a concurrent burst of 60 webhooks with mixed synchronize, closed, and reopened events without crashing or exceeding 3s SLA', async () => {
      const harness = createHarness();
      const secret = 'test-secret-iter3';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 101;

      // 1. Establish an active in-flight run on PR 101
      const activeRunId = 'run_active_pr101';
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId, headSha: 'sha_base_pr101', prNumber }),
      });

      const runDO = harness.env.REVIEW_RUN.get(harness.env.REVIEW_RUN.idFromName(activeRunId));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId,
          owner: 'exampleorg',
          repo: 'review-yeti',
          prNumber,
          headSha: 'sha_base_pr101',
          baseSha: 'main',
        }),
      });
      await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker-initial', epoch: 1 }),
      });

      // Verify active before burst
      const statusBefore = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(statusBefore.phase, 'Running');
      assert.equal(statusBefore.fencingEpoch, 1);

      // 2. Dispatch a burst of 60 concurrent webhooks: 20 synchronize, 20 closed, 20 reopened in interleaved order
      const burstSize = 60;
      const actions: Array<'synchronize' | 'closed' | 'reopened'> = [];
      for (let i = 0; i < 20; i++) {
        actions.push('synchronize', 'closed', 'reopened');
      }

      const burstStart = performance.now();
      const requests = actions.map(async (action, idx) => {
        const body = JSON.stringify({
          action,
          repository: {
            full_name: 'exampleorg/review-yeti',
            name: 'review-yeti',
            owner: { login: 'exampleorg' },
          },
          pull_request: {
            number: prNumber,
            head: { sha: `sha_burst_${idx}` },
            base: { sha: 'main' },
          },
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
        const resBody = (await res.json()) as any;
        return { idx, action, status: res.status, reqDuration, resBody };
      });

      const responses = await Promise.all(requests);
      const totalDuration = performance.now() - burstStart;

      // Assert SLA: all requests resolved in < 3000ms total
      assert.ok(
        totalDuration < 3000,
        `Burst of 60 requests took ${totalDuration.toFixed(2)}ms, exceeding 3000ms SLA`
      );

      // Assert all requests succeeded (200 OK)
      for (const resp of responses) {
        assert.equal(
          resp.status,
          200,
          `Request ${resp.idx} (${resp.action}) failed with HTTP ${resp.status}`
        );
        if (resp.action === 'synchronize') {
          assert.equal(resp.resBody.status, 'queued_debounced');
        } else if (resp.action === 'closed') {
          assert.equal(resp.resBody.status, 'cancelled');
        } else if (resp.action === 'reopened') {
          // Reopened is ignored by ingress worker per spec
          assert.equal(resp.resBody.status, 'ignored');
        }
      }

      // Verify the active run is cancelled, epoch bumped, and receipts rejected
      const statusAfter = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(statusAfter.phase, 'Cancelled');
      assert.ok(statusAfter.fencingEpoch >= 2, 'Epoch must be >= 2');
      assert.equal(statusAfter.isCurrentHead, false);

      const staleReceipt = (await (
        await runDO.fetch('http://do/receipt', {
          method: 'POST',
          body: JSON.stringify({ receipt: { verdict: 'success' }, epoch: 1 }),
        })
      ).json()) as any;
      assert.equal(staleReceipt.accepted, false);
    });

    it('processes multi-PR rapid-fire bursts across 10 distinct PRs concurrently with total isolation', async () => {
      const harness = createHarness();
      const secret = 'test-secret-iter3';
      const repoKey = 'exampleorg/review-yeti';

      // 10 PRs: numbers 201 to 210
      const prs = Array.from({ length: 10 }, (_, i) => 201 + i);
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));

      // Occupy gate with PR 201
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: 'run_201_active', headSha: 'sha201', prNumber: 201 }),
      });

      // Fire 60 requests (6 per PR: 2 synchronize, 2 closed, 2 reopened)
      const tasks: Promise<any>[] = [];
      for (const prNumber of prs) {
        for (const action of ['synchronize', 'reopened', 'closed', 'synchronize', 'reopened', 'closed'] as const) {
          tasks.push(
            (async () => {
              const body = JSON.stringify({
                action,
                repository: {
                  full_name: 'exampleorg/review-yeti',
                  name: 'review-yeti',
                  owner: { login: 'exampleorg' },
                },
                pull_request: {
                  number: prNumber,
                  head: { sha: `sha_${prNumber}_${action}` },
                  base: { sha: 'main' },
                },
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
              return { prNumber, action, status: res.status };
            })()
          );
        }
      }

      const results = await Promise.all(tasks);
      assert.equal(results.length, 60);
      assert.ok(results.every((r) => r.status === 200));

      // Check RepoGateDO state: only PR 201 was active, now cancelled
      const gateStatus = (await (await repoGate.fetch('http://do/status')).json()) as any;
      // All queued runs for closed PRs should have been evicted
      assert.equal(gateStatus.queueLength, 0);
    });

    it('EMPIRICAL RACE PROBE: investigates whether debounced commit executes if PR was closed during 60s quiet window', async () => {
      const harness = createHarness();
      const runner = new MockContainerRunner();
      const workflow = new ReviewJobWorkflow(harness.env, runner);
      const secret = 'test-secret-iter3';
      const repoKey = 'exampleorg/review-yeti';
      const prNumber = 150;

      // 1. Developer pushes a commit to PR 150: synchronize arrives
      const bodySync = JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
        pull_request: { number: prNumber, head: { sha: 'sha_sync_150' }, base: { sha: 'main' } },
      });
      const sigSync = await signPayload(secret, bodySync);
      const resSync = await worker.fetch(
        new Request('https://operator.example.com/api/webhooks/github', {
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

      // Assert it was enqueued to REVIEW_DEBOUNCE_QUEUE
      assert.equal(harness.queuedDebounceMessages.length, 1);
      const debounceMsg = harness.queuedDebounceMessages[0];
      assert.equal(debounceMsg.runId, debouncedRunId);

      // 2. Ten seconds later, developer CLOSES PR 150!
      const bodyClose = JSON.stringify({
        action: 'closed',
        repository: { full_name: 'exampleorg/review-yeti', name: 'review-yeti', owner: { login: 'exampleorg' } },
        pull_request: { number: prNumber, head: { sha: 'sha_sync_150' }, base: { sha: 'main' } },
      });
      const sigClose = await signPayload(secret, bodyClose);
      const resClose = await worker.fetch(
        new Request('https://operator.example.com/api/webhooks/github', {
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

      // 3. Now 60 seconds expire: the queue consumer runs for debounceMsg
      const fakeBatch: any = {
        messages: [
          {
            body: debounceMsg,
            ack: () => {},
          },
        ],
      };
      await worker.queue(fakeBatch, harness.env);

      // Assert workflow create was called
      assert.equal(harness.dispatchedWorkflows.length, 1);
      const dispatched = harness.dispatchedWorkflows[0];
      assert.equal(dispatched.id, debouncedRunId);

      // 4. Now the workflow attempts to run:
      // Does RepoGateDO reject or grant the slot?
      // When PR 150 was closed, RepoGateDO set latestRunIdByPr.set(150, '__EVICTED__').
      // Let's see if acquireSlot grants or evicts:
      const repoGate = harness.env.REPO_GATE.get(harness.env.REPO_GATE.idFromName(repoKey));
      const acquireRes = (await (
        await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({
            runId: debouncedRunId,
            headSha: 'sha_sync_150',
            prNumber: 150,
          }),
        })
      ).json()) as any;

      console.log('--- Debounced synchronize after PR closed probe ---');
      console.log('Acquire result for debounced commit on closed PR:', acquireRes);

      // If PR was closed, debounced commit should NOT be granted a slot!
      assert.equal(
        acquireRes.granted,
        false,
        `Vulnerability Confirmed: Debounced commit from closed PR was GRANTED slot! Result: ${JSON.stringify(acquireRes)}`
      );
      assert.equal(acquireRes.evicted, true);
    });
  });

  // =========================================================================
  // Mission Area 2: In-place re-polling queue seniority preservation
  // =========================================================================
  describe('Mission Area 2: In-Place Re-Polling Queue Seniority Preservation', () => {
    it('strictly preserves FIFO queue position and enqueuedAt timestamp under aggressive re-polling', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // PR 1 occupies active slot
      const rActive = await gate.acquireSlot('run_active', 'sha_active', 1);
      assert.equal(rActive.granted, true);

      // Queue up 4 distinct PRs: PR 10, PR 20, PR 30, PR 40
      const r10 = await gate.acquireSlot('run_pr10', 'sha_10_v1', 10);
      assert.equal(r10.granted, false);
      assert.equal(r10.queuePosition, 1);

      const r20 = await gate.acquireSlot('run_pr20', 'sha_20_v1', 20);
      assert.equal(r20.granted, false);
      assert.equal(r20.queuePosition, 2);

      const r30 = await gate.acquireSlot('run_pr30', 'sha_30_v1', 30);
      assert.equal(r30.granted, false);
      assert.equal(r30.queuePosition, 3);

      const r40 = await gate.acquireSlot('run_pr40', 'sha_40_v1', 40);
      assert.equal(r40.granted, false);
      assert.equal(r40.queuePosition, 4);

      // Read raw storage queue to inspect enqueuedAt timestamps
      const rawQueueBefore = (await state.storage.get<any[]>('queue'))!;
      assert.equal(rawQueueBefore.length, 4);
      const initialTimestamps = {
        pr10: rawQueueBefore[0].enqueuedAt,
        pr20: rawQueueBefore[1].enqueuedAt,
        pr30: rawQueueBefore[2].enqueuedAt,
        pr40: rawQueueBefore[3].enqueuedAt,
      };

      // PR 30 and PR 40 aggressively re-poll 100 times each in interleaved order
      // with updated headShas to simulate worker poll steps
      for (let i = 0; i < 100; i++) {
        // PR 30 re-polls (in queue at pos 3)
        const poll30 = await gate.acquireSlot('run_pr30', `sha_30_poll_${i}`, 30);
        assert.equal(poll30.granted, false);
        assert.equal(poll30.queuePosition, 3, 'PR 30 queue position must stay 3');

        // PR 40 re-polls (in queue at pos 4)
        const poll40 = await gate.acquireSlot('run_pr40', `sha_40_poll_${i}`, 40);
        assert.equal(poll40.granted, false);
        assert.equal(poll40.queuePosition, 4, 'PR 40 queue position must stay 4');
      }

      // Inspect queue again: PR 10 (which never re-polled) MUST still be at index 0!
      // All original enqueuedAt timestamps MUST remain unchanged!
      const rawQueueAfter = (await state.storage.get<any[]>('queue'))!;
      assert.equal(rawQueueAfter.length, 4);

      assert.equal(rawQueueAfter[0].runId, 'run_pr10');
      assert.equal(rawQueueAfter[0].enqueuedAt, initialTimestamps.pr10, 'PR 10 timestamp must be unchanged');

      assert.equal(rawQueueAfter[1].runId, 'run_pr20');
      assert.equal(rawQueueAfter[1].enqueuedAt, initialTimestamps.pr20, 'PR 20 timestamp must be unchanged');

      assert.equal(rawQueueAfter[2].runId, 'run_pr30');
      assert.equal(rawQueueAfter[2].enqueuedAt, initialTimestamps.pr30, 'PR 30 timestamp must be unchanged');
      assert.equal(rawQueueAfter[2].headSha, 'sha_30_poll_99', 'PR 30 headSha must be updated in-place');

      assert.equal(rawQueueAfter[3].runId, 'run_pr40');
      assert.equal(rawQueueAfter[3].enqueuedAt, initialTimestamps.pr40, 'PR 40 timestamp must be unchanged');
      assert.equal(rawQueueAfter[3].headSha, 'sha_40_poll_99', 'PR 40 headSha must be updated in-place');

      // Now verify strict FIFO promotion as slots are released
      const rel1 = await gate.releaseSlot('run_active');
      assert.equal(rel1.nextRunId, 'run_pr10', 'Seniority preserved: PR 10 promoted first');

      const rel2 = await gate.releaseSlot('run_pr10');
      assert.equal(rel2.nextRunId, 'run_pr20', 'Seniority preserved: PR 20 promoted second');

      const rel3 = await gate.releaseSlot('run_pr20');
      assert.equal(rel3.nextRunId, 'run_pr30', 'Seniority preserved: PR 30 promoted third');

      const rel4 = await gate.releaseSlot('run_pr30');
      assert.equal(rel4.nextRunId, 'run_pr40', 'Seniority preserved: PR 40 promoted fourth');

      const rel5 = await gate.releaseSlot('run_pr40');
      assert.equal(rel5.nextRunId, undefined);
    });

    it('confirms re-polling an active run returns granted idempotently and preserves latestRunIdByPr', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      const acq1 = await gate.acquireSlot('run_active_1', 'sha_1', 77);
      assert.equal(acq1.granted, true);

      // Re-poll active run 10 times
      for (let i = 0; i < 10; i++) {
        const repoll = await gate.acquireSlot('run_active_1', 'sha_1', 77);
        assert.equal(repoll.granted, true);
      }

      assert.equal(gate.getActiveRun(77), 'run_active_1');
      const storedLatest = await state.storage.get<[number, string][]>('latestRunIdByPr');
      const latestMap = new Map(storedLatest);
      assert.equal(latestMap.get(77), 'run_active_1');
    });
  });

  // =========================================================================
  // Mission Area 3: Durable Object restart persistence
  // =========================================================================
  describe('Mission Area 3: Durable Object Restart Persistence', () => {
    it('verifies latestRunIdByPr and prRunsSeen survive DO hibernation and restart', async () => {
      // Shared persistent storage simulating Cloudflare DO storage across restarts
      const sharedState = new MockDurableObjectState();
      const env: any = {};

      // DO Instance 1: Initial lifecycle
      const gate1 = new RepoGateDO(sharedState as any, env);

      // PR 50 receives Commit 1 (active)
      await gate1.acquireSlot('run_50_v1', 'sha_50_1', 50);

      // PR 60 receives Commit 1 (active jobs is 1, so PR 60 is queued)
      await gate1.acquireSlot('run_60_v1', 'sha_60_1', 60);

      // PR 60 receives Commit 2 (supersedes Commit 1 in queue)
      await gate1.acquireSlot('run_60_v2', 'sha_60_2', 60);

      // Verify state in Instance 1 before restart
      const status1 = await gate1.getStatus();
      assert.equal(status1.activeCount, 1);
      assert.equal(status1.queueLength, 1);

      // SIMULATE DO RESTART / HIBERNATION:
      // Instance 1 is evicted from memory. Instance 2 is constructed with the SAME sharedState.storage.
      const gate2 = new RepoGateDO(sharedState as any, env);

      // Instance 2 should hydrate latestRunIdByPr and prRunsSeen in constructor
      const status2 = await gate2.getStatus();
      assert.equal(status2.activeCount, 1);
      assert.equal(status2.activeJobs[0], 'run_50_v1');
      assert.equal(status2.queueLength, 1);

      // Check stale run rejection on Instance 2:
      // run_60_v1 was superseded by run_60_v2. When run_60_v1 re-polls instance 2:
      const staleRepoll = await gate2.acquireSlot('run_60_v1', 'sha_60_1', 60);
      assert.equal(
        staleRepoll.granted,
        false,
        'Stale run 1 must be rejected after DO restart'
      );
      assert.equal(
        staleRepoll.evicted,
        true,
        'Stale run 1 must be marked evicted after DO restart'
      );

      // Check valid run re-poll on Instance 2:
      // run_60_v2 re-polls instance 2:
      const validRepoll = await gate2.acquireSlot('run_60_v2', 'sha_60_2', 60);
      assert.equal(validRepoll.granted, false);
      assert.equal(validRepoll.queuePosition, 1, 'Valid run 2 must stay at position 1 after DO restart');

      // Check slot release and promotion on Instance 2:
      const release1 = await gate2.releaseSlot('run_50_v1');
      assert.equal(release1.released, true);
      assert.equal(release1.nextRunId, 'run_60_v2', 'Valid run 2 promoted on Instance 2');
    });

    it('EMPIRICAL BOUNDARY PROBE: investigates whether evictQueue({ prNumber }) persists __EVICTED__ when queue is empty for that PR', async () => {
      // Shared persistent storage simulating DO storage surviving across hibernation/restarts
      const sharedState = new MockDurableObjectState();
      const env: any = {};

      // DO Instance 1
      const gate1 = new RepoGateDO(sharedState as any, env);

      // PR 80 had run_80_v1 in the past (it ran, completed, and released slot)
      await gate1.acquireSlot('run_80_v1', 'sha_80_v1', 80);
      await gate1.releaseSlot('run_80_v1');

      // Verify PR 80 was recorded in latestRunIdByPr and prRunsSeen in storage
      const storedLatestBefore = await sharedState.storage.get<[number, string][]>('latestRunIdByPr');
      const mapBefore = new Map(storedLatestBefore);
      assert.equal(mapBefore.get(80), 'run_80_v1');

      // Now developer CLOSES PR 80!
      // worker.ts receives 'closed' webhook and calls evictQueuedRunsForPR(80)
      // which sends POST /evict with { prNumber: 80 } to RepoGateDO:
      const evictRes = await gate1.evictQueue({ prNumber: 80 });
      console.log('--- evictQueue empty-queue probe ---');
      console.log('Evict result:', evictRes);

      // Check what is in storage immediately after evictQueue:
      const storedLatestImmediately = await sharedState.storage.get<[number, string][]>('latestRunIdByPr');
      const mapImmediately = new Map(storedLatestImmediately);
      console.log('Stored latestRunIdByPr immediately after evictQueue for PR 80:', mapImmediately.get(80));

      const persistedEvicted = mapImmediately.get(80) === '__EVICTED__';
      console.log('Did evictQueue persist __EVICTED__ to storage?', persistedEvicted);

      // NOW SIMULATE DO RESTART / HIBERNATION:
      // Instance 1 is evicted from memory. Instance 2 boots from storage.
      const gate2 = new RepoGateDO(sharedState as any, env);

      // Stale run_80_v1 re-polls on the restarted DO:
      const repollRes = await gate2.acquireSlot('run_80_v1', 'sha_80_v1', 80);
      console.log('Repoll result for stale run_80_v1 on restarted DO:', repollRes);

      // Since PR 80 was closed, run_80_v1 MUST be rejected (granted: false, evicted: true)
      // BUT because __EVICTED__ was not persisted, gate2 thinks latestRunIdByPr is run_80_v1!
      // And since activeJobs is empty, gate2 GRANTS the slot to the stale run!
      assert.equal(
        repollRes.granted,
        false,
        `Vulnerability Confirmed: Stale run from closed PR was RESURRECTED and GRANTED slot after DO restart! repollRes=${JSON.stringify(repollRes)}`
      );
      assert.equal(
        repollRes.evicted,
        true,
        'Stale run from closed PR must be marked evicted after DO restart!'
      );
      assert.equal(
        persistedEvicted,
        true,
        `Persistence Failure: evictQueue({ prNumber: 80 }) did not persist '__EVICTED__' to storage! Storage still has: ${mapImmediately.get(80)}`
      );
    });
  });
});
