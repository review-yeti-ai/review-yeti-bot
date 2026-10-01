import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isPilotRepository, verifyGitHubSignature } from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
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

/**
 * Creates an empirical test environment wiring the REAL compiled RepoGateDO and ReviewRunDO classes.
 */
function createEmpiricalTestEnv() {
  const repoGateInstances = new Map<string, RepoGateDO>();
  const reviewRunInstances = new Map<string, ReviewRunDO>();
  const debounceQueue: Array<{ msg: DebounceMessagePayload; options?: any; receivedAt: number }> = [];
  const workflows: Array<{ id: string; params: any }> = [];
  const fanoutRequests: Array<{ url: string; body: string }> = [];
  const waitUntilPromises: Array<Promise<any>> = [];

  const mockCtx = {
    waitUntil: (p: Promise<any>) => {
      waitUntilPromises.push(p);
    },
  };

  const env: any = {
    ENVIRONMENT: 'production',
    PARALLEL_MODE: 'shadow',
    PILOT_REPOSITORIES: 'calltelemetry/review-yeti,review-yeti-ai/review-yeti-bot',
    GITHUB_WEBHOOK_SECRET: 'm1-adversarial-challenge-secret-999',
    DOKS_FALLBACK_URL: 'https://doks-internal.calltelemetry.com/webhooks/github',
    PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/calltelemetry/review-yeti-worker:latest',
    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (id: string) => {
        const key = id.toLowerCase();
        if (!repoGateInstances.has(key)) {
          repoGateInstances.set(key, new RepoGateDO(new MockDurableObjectState() as any, env));
        }
        const instance = repoGateInstances.get(key)!;
        return {
          fetch: async (input: string | Request, init?: RequestInit) => {
            const req = typeof input === 'string' ? new Request(input, init) : input;
            return instance.fetch(req);
          },
        };
      },
    },
    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!reviewRunInstances.has(id)) {
          reviewRunInstances.set(id, new ReviewRunDO(new MockDurableObjectState() as any, env));
        }
        const instance = reviewRunInstances.get(id)!;
        return {
          fetch: async (input: string | Request, init?: RequestInit) => {
            const req = typeof input === 'string' ? new Request(input, init) : input;
            return instance.fetch(req);
          },
        };
      },
    },
    REVIEW_DEBOUNCE_QUEUE: {
      send: async (msg: any, options?: any) => {
        debounceQueue.push({ msg, options, receivedAt: Date.now() });
      },
    },
    REVIEW_JOB_WORKFLOW: {
      create: async ({ id, params }: any) => {
        workflows.push({ id, params });
        return { id };
      },
    },
  };

  return { env, repoGateInstances, reviewRunInstances, debounceQueue, workflows, fanoutRequests, mockCtx, waitUntilPromises };
}

describe('M1 Empirical Challenge: Commit Supersession & Burst Stress Tests', () => {
  it('cancels active run within < 3 seconds SLA and increments fencing epoch when a burst of 10 commits arrives', async () => {
    const { env, repoGateInstances, reviewRunInstances, debounceQueue, mockCtx } = createEmpiricalTestEnv();
    const repoKey = 'calltelemetry/review-yeti';
    const prNumber = 77;
    const initialRunId = 'run_initial_001';

    // 1. Establish an active in-flight run for PR #77 in RepoGateDO and ReviewRunDO
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const slotAcq = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: initialRunId, headSha: 'commit_sha_0', prNumber }),
    });
    const slotAcqRes = await slotAcq.json() as any;
    assert.equal(slotAcqRes.granted, true, 'Initial run should acquire concurrency slot');

    const runDOId = env.REVIEW_RUN.idFromName(initialRunId);
    const runDO = env.REVIEW_RUN.get(runDOId);
    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId: initialRunId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber,
        headSha: 'commit_sha_0',
        baseSha: 'base_sha_0',
      }),
    });
    // Worker 1 acquires initial lease
    const leaseRes = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_alpha', epoch: 1, durationMs: 60_000 }),
    });
    const leaseData = await leaseRes.json() as any;
    assert.equal(leaseData.ok, true);

    // Verify initial state: epoch = 1, phase = Running, isCurrentHead = true
    const preStatusRes = await runDO.fetch('http://do/status');
    const preStatus = await preStatusRes.json() as any;
    assert.equal(preStatus.phase, 'Running');
    assert.equal(preStatus.fencingEpoch, 1);
    assert.equal(preStatus.isCurrentHead, true);

    // 2. Adversarial burst: Send 10 commits in rapid succession
    const burstSize = 10;
    const burstResponses: any[] = [];
    const t0 = performance.now();

    for (let i = 1; i <= burstSize; i++) {
      const payload = {
        action: 'synchronize',
        pull_request: {
          number: prNumber,
          head: { sha: `commit_burst_sha_${i}` },
          base: { sha: 'base_sha_0' },
          draft: false,
        },
        repository: {
          name: 'review-yeti',
          full_name: repoKey,
          owner: { login: 'calltelemetry' },
        },
        installation: { id: 5555 },
      };
      const rawBody = JSON.stringify(payload);
      const signature = await signPayload(env.GITHUB_WEBHOOK_SECRET, rawBody);

      const req = new Request('https://operator.calltelemetry.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': signature,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.ok(
        res.status === 200 || res.status === 202,
        `Expected status 200 or 202, got ${res.status}`
      );
      const resJson = await res.json() as any;
      assert.equal(resJson.status, 'queued_debounced');
      burstResponses.push(resJson);
    }

    const t1 = performance.now();
    const durationMs = t1 - t0;

    // SLA Assertion 1: Supersession cancellation triggered in < 3000ms
    assert.ok(durationMs < 3000, `Burst supersession processing took ${durationMs}ms, must be < 3000ms`);

    // SLA Assertion 2: The older run MUST be cancelled
    const postStatusRes = await runDO.fetch('http://do/status');
    const postStatus = await postStatusRes.json() as any;
    assert.equal(postStatus.phase, 'Cancelled', 'Older run must transition to Cancelled phase');
    assert.equal(postStatus.cancelRequested, true);
    assert.equal(postStatus.isCurrentHead, false, 'Older run must NOT be current head');

    // SLA Assertion 3: Fencing epoch MUST strictly increment on cancellation
    assert.equal(postStatus.fencingEpoch, 2, 'Fencing epoch must strictly increment from 1 to 2 on supersession');

    // Verify first response reported supersededRunId = initialRunId
    assert.equal(burstResponses[0].supersededRunId, initialRunId);

    // 3. Stale worker MUST be fenced out immediately
    // Stale heartbeat rejected
    const staleHeartbeatRes = await runDO.fetch('http://do/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_alpha', epoch: 1 }),
    });
    const staleHeartbeat = await staleHeartbeatRes.json() as any;
    assert.equal(staleHeartbeat.ok, false);
    assert.ok(staleHeartbeat.reason === 'cancel_requested' || staleHeartbeat.reason === 'fencing_epoch_mismatch');

    // Stale receipt rejected
    const staleReceiptRes = await runDO.fetch('http://do/receipt', {
      method: 'POST',
      body: JSON.stringify({
        receipt: { verdict: 'success', status: 'succeeded', fencingEpoch: 1 },
        epoch: 1,
      }),
    });
    const staleReceipt = await staleReceiptRes.json() as any;
    assert.equal(staleReceipt.accepted, false);
    assert.equal(staleReceipt.reason, 'run_cancelled');

    // Forged epoch receipt rejected
    const forgedReceiptRes = await runDO.fetch('http://do/receipt', {
      method: 'POST',
      body: JSON.stringify({
        receipt: { verdict: 'success', status: 'succeeded', fencingEpoch: 2 },
        epoch: 2,
      }),
    });
    const forgedReceipt = await forgedReceiptRes.json() as any;
    assert.equal(forgedReceipt.accepted, false);
    assert.equal(forgedReceipt.reason, 'run_cancelled');
  });

  it('evicts stale queued runs in RepoGateDO when multiple commits arrive before slot is granted', async () => {
    const { env } = createEmpiricalTestEnv();
    const repoKey = 'calltelemetry/review-yeti';
    const prNumber = 88;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);

    // Step A: Run 0 occupies the active concurrency slot (maxConcurrency = 1)
    const run0Res = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_occupant_0', headSha: 'sha_0', prNumber }),
    });
    const run0Data = await run0Res.json() as any;
    assert.equal(run0Data.granted, true);

    // Step B: Commit 1 (Run 1) attempts to acquire slot -> queued
    const run1Res = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_queued_1', headSha: 'sha_1', prNumber }),
    });
    const run1Data = await run1Res.json() as any;
    assert.equal(run1Data.granted, false);
    assert.equal(run1Data.queuePosition, 1);

    // Verify queue length is 1
    let statusRes = await repoGate.fetch('http://do/status');
    let status = await statusRes.json() as any;
    assert.equal(status.queueLength, 1);

    // Step C: Commit 2 (Run 2) arrives for the SAME PR -> MUST evict Run 1!
    const run2Res = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_queued_2', headSha: 'sha_2', prNumber }),
    });
    const run2Data = await run2Res.json() as any;
    assert.equal(run2Data.granted, false);
    // Queue position should be 1 because Run 1 was evicted!
    assert.equal(run2Data.queuePosition, 1);

    statusRes = await repoGate.fetch('http://do/status');
    status = await statusRes.json() as any;
    assert.equal(status.queueLength, 1, 'Queue length must remain 1 after stale commit eviction');

    // Step D: Commit 3 (Run 3) arrives for the SAME PR -> MUST evict Run 2!
    const run3Res = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_queued_3', headSha: 'sha_3', prNumber }),
    });
    const run3Data = await run3Res.json() as any;
    assert.equal(run3Data.granted, false);
    assert.equal(run3Data.queuePosition, 1);

    statusRes = await repoGate.fetch('http://do/status');
    status = await statusRes.json() as any;
    assert.equal(status.queueLength, 1);

    // Step E: Occupant releases slot -> Only the LATEST commit (Run 3) should be promoted!
    const releaseRes = await repoGate.fetch('http://do/release', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_occupant_0' }),
    });
    const releaseData = await releaseRes.json() as any;
    assert.equal(releaseData.released, true);
    assert.equal(releaseData.nextRunId, 'run_queued_3', 'Only the latest commit (run_queued_3) must be promoted');

    // Check active run for PR 88 is now run_queued_3
    const activePrRes = await repoGate.fetch(`http://do/active-run/${prNumber}`);
    const activePrData = await activePrRes.json() as any;
    assert.equal(activePrData.activeRunId, 'run_queued_3');
  });

  it('supports explicit queue eviction by PR number and runId via POST /evict', async () => {
    const { env } = createEmpiricalTestEnv();
    const repoKey = 'calltelemetry/review-yeti';
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);

    // Hold slot with active run
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'active_run_999', headSha: 'sha_root', prNumber: 999 }),
    });

    // Queue 3 different PR runs
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'queued_pr_1', headSha: 'sha_pr1', prNumber: 1 }),
    });
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'queued_pr_2', headSha: 'sha_pr2', prNumber: 2 }),
    });
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'queued_pr_3', headSha: 'sha_pr3', prNumber: 3 }),
    });

    let status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.queueLength, 3);

    // Evict PR #2 by prNumber
    const evictPrRes = await repoGate.fetch('http://do/evict', {
      method: 'POST',
      body: JSON.stringify({ prNumber: 2 }),
    });
    const evictPrData = await evictPrRes.json() as any;
    assert.equal(evictPrData.evicted, true);
    assert.equal(evictPrData.count, 1);

    status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.queueLength, 2);

    // Evict queued_pr_1 by runId
    const evictRunRes = await repoGate.fetch('http://do/evict', {
      method: 'POST',
      body: JSON.stringify({ runId: 'queued_pr_1' }),
    });
    const evictRunData = await evictRunRes.json() as any;
    assert.equal(evictRunData.evicted, true);
    assert.equal(evictRunData.count, 1);

    status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.queueLength, 1);
  });
});

describe('M1 Empirical Challenge: Worker Lease Fencing & Rival Workers', () => {
  it('prevents rival worker lease acquisition while lease is unexpired', async () => {
    const { env } = createEmpiricalTestEnv();
    const runId = 'run_fencing_rival_test';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 50,
        headSha: 'fencing_sha_1',
        baseSha: 'base_sha_1',
      }),
    });

    // Worker 1 acquires 60s lease
    const acq1 = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_primary', epoch: 1, durationMs: 60_000, jobId: 'job_p' }),
    });
    const acq1Data = await acq1.json() as any;
    assert.equal(acq1Data.ok, true);

    // Rival Worker 2 attempts to acquire lease on same epoch
    const rivalAcq = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_rival', epoch: 1, durationMs: 30_000, jobId: 'job_r' }),
    });
    const rivalData = await rivalAcq.json() as any;
    assert.equal(rivalData.ok, false);
    assert.equal(rivalData.reason, 'lease_already_held', 'Rival worker must be rejected with lease_already_held');

    // Rival Worker 2 attempts heartbeat on Worker 1 lease
    const rivalHb = await runDO.fetch('http://do/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_rival', epoch: 1 }),
    });
    const rivalHbData = await rivalHb.json() as any;
    assert.equal(rivalHbData.ok, false);
    assert.equal(rivalHbData.reason, 'worker_id_mismatch');

    // Primary Worker 1 heartbeat succeeds
    const primaryHb = await runDO.fetch('http://do/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_primary', epoch: 1, durationMs: 45_000 }),
    });
    const primaryHbData = await primaryHb.json() as any;
    assert.equal(primaryHbData.ok, true);
  });

  it('allows rival worker acquisition after active lease expires', async () => {
    const { env } = createEmpiricalTestEnv();
    const runId = 'run_fencing_expiration_test';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 51,
        headSha: 'fencing_sha_2',
        baseSha: 'base_sha_2',
      }),
    });

    // Worker 1 acquires short 50ms lease
    const acq1 = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_short_lived', epoch: 1, durationMs: 50 }),
    });
    assert.equal((await acq1.json() as any).ok, true);

    // Wait 70ms for lease to expire
    await new Promise((r) => setTimeout(r, 70));

    // Worker 1 heartbeat should fail because lease expired
    const expiredHb = await runDO.fetch('http://do/lease/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_short_lived', epoch: 1 }),
    });
    const expiredHbData = await expiredHb.json() as any;
    assert.equal(expiredHbData.ok, false);
    assert.equal(expiredHbData.reason, 'lease_expired');

    // Rival Worker 2 can now acquire the expired lease!
    const acq2 = await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_successor', epoch: 1, durationMs: 60_000 }),
    });
    const acq2Data = await acq2.json() as any;
    assert.equal(acq2Data.ok, true, 'Successor worker must be granted lease after expiration');
  });

  it('handles 50 concurrent rival lease acquisitions with exactly 1 winner and 49 rejections', async () => {
    const { env } = createEmpiricalTestEnv();
    const runId = 'run_fencing_50_rivals';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 52,
        headSha: 'sha_50_rivals',
        baseSha: 'base_sha_50',
      }),
    });

    const rivalCount = 50;
    const promises: Promise<any>[] = [];

    for (let i = 1; i <= rivalCount; i++) {
      const p = runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: `worker_candidate_${i}`, epoch: 1, durationMs: 30_000 }),
      }).then((r: Response) => r.json() as any);
      promises.push(p);
    }

    const results = await Promise.all(promises);
    const granted = results.filter((r) => r.ok === true);
    const rejected = results.filter((r) => r.ok === false && r.reason === 'lease_already_held');

    assert.equal(granted.length, 1, 'Exactly one worker must acquire the lease');
    assert.equal(rejected.length, 49, 'All other 49 rival workers must be rejected with lease_already_held');
  });

  it('cancellation is idempotent and epoch remains stable on subsequent calls', async () => {
    const { env } = createEmpiricalTestEnv();
    const runId = 'run_idempotence_test';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 53,
        headSha: 'sha_idem',
        baseSha: 'base_sha_idem',
      }),
    });

    // First cancellation: bumps epoch 1 -> 2
    const cancel1Res = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded_1' }),
    });
    const cancel1 = await cancel1Res.json() as any;
    assert.equal(cancel1.cancelled, true);
    assert.equal(cancel1.fencingEpoch, 2);

    // Second cancellation: idempotent, epoch stays 2
    const cancel2Res = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded_2' }),
    });
    const cancel2 = await cancel2Res.json() as any;
    assert.equal(cancel2.cancelled, true);
    assert.equal(cancel2.previousPhase, 'Cancelled');
    assert.equal(cancel2.fencingEpoch, 2, 'Epoch must not continuously increment on duplicate cancel calls');
  });

  it('rejects terminal receipt submissions when run is already completed', async () => {
    const { env } = createEmpiricalTestEnv();
    const runId = 'run_receipt_duplicate_test';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 54,
        headSha: 'sha_term',
        baseSha: 'base_sha_term',
      }),
    });

    await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_receipt', epoch: 1 }),
    });

    // First receipt: accepted
    const receipt1Res = await runDO.fetch('http://do/receipt', {
      method: 'POST',
      body: JSON.stringify({
        receipt: { verdict: 'success', status: 'succeeded', fencingEpoch: 1 },
        epoch: 1,
      }),
    });
    assert.equal((await receipt1Res.json() as any).accepted, true);

    const status = await (await runDO.fetch('http://do/status')).json() as any;
    assert.equal(status.phase, 'Completed');

    // Duplicate receipt: rejected with already_terminal
    const receipt2Res = await runDO.fetch('http://do/receipt', {
      method: 'POST',
      body: JSON.stringify({
        receipt: { verdict: 'neutral', status: 'succeeded', fencingEpoch: 1 },
        epoch: 1,
      }),
    });
    const receipt2 = await receipt2Res.json() as any;
    assert.equal(receipt2.accepted, false);
    assert.equal(receipt2.reason, 'already_terminal');
  });
});

describe('M1 Empirical Challenge: Queue Eviction & Polling Race Condition Stress Test', () => {
  it('reproduces and tests queue polling behavior during commit supersession', async () => {
    const { env } = createEmpiricalTestEnv();
    const repoKey = 'calltelemetry/review-yeti';
    const prNumber = 60;
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);

    // Initial occupant
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_active_occ', headSha: 'sha_occ', prNumber }),
    });

    // Commit 1 enters queue
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_c1', headSha: 'sha_c1', prNumber }),
    });

    // Commit 2 arrives and enters queue (evicting Commit 1 from RepoGateDO queue)
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_c2', headSha: 'sha_c2', prNumber }),
    });

    let status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.queueLength, 1);

    // Now test: If the evicted workflow (run_c1) polls again (as in reviewJobWorkflow step.sleep loop):
    // What happens when run_c1 calls acquireSlot?
    const stalePollRes = await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_c1', headSha: 'sha_c1', prNumber }),
    });
    const stalePoll = await stalePollRes.json() as any;
    assert.equal(stalePoll.granted, false);

    // Now if occupant releases slot:
    const releaseRes = await repoGate.fetch('http://do/release', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run_active_occ' }),
    });
    const releaseData = await releaseRes.json() as any;
    assert.equal(releaseData.released, true);

    // NOTE: If run_c1 polled after run_c2, line 61 of repoGateDO evicts run_c2 and puts run_c1!
    // Let's observe which run was promoted:
    console.log(`[Empirical Observation] Promoted run after stale poll: ${releaseData.nextRunId}`);
  });
});

describe('M1 Empirical Challenge: Pull-Path Worker Invalidation & Ingress Security', () => {
  it('exposes accurate cancellation state to workers via GET /api/dispatch/runs/:runId/status', async () => {
    const { env, mockCtx } = createEmpiricalTestEnv();
    const runId = 'run_pull_path_test_01';
    const runDOId = env.REVIEW_RUN.idFromName(runId);
    const runDO = env.REVIEW_RUN.get(runDOId);

    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId,
        owner: 'calltelemetry',
        repo: 'review-yeti',
        prNumber: 90,
        headSha: 'sha_head_pull',
        baseSha: 'sha_base_pull',
      }),
    });

    await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_pull', epoch: 1, durationMs: 60_000, jobId: 'job_pull_1' }),
    });

    // Query status via Worker route: GET /api/dispatch/runs/:runId/status
    const req1 = new Request(`https://operator.calltelemetry.internal/api/dispatch/runs/${runId}/status`);
    const res1 = await worker.fetch(req1, env, mockCtx as any);
    assert.equal(res1.status, 200);
    const status1 = await res1.json() as any;
    assert.equal(status1.phase, 'Running');
    assert.equal(status1.isCurrentHead, true);
    assert.equal(status1.cancelRequested, false);
    assert.equal(status1.fencingEpoch, 1);
    assert.equal(status1.headSha, 'sha_head_pull');

    // Cancel run (superseded)
    await runDO.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded_by_commit' }),
    });

    // Query status again via Worker route
    const req2 = new Request(`https://operator.calltelemetry.internal/api/dispatch/runs/${runId}/status`);
    const res2 = await worker.fetch(req2, env, mockCtx as any);
    assert.equal(res2.status, 200);
    const status2 = await res2.json() as any;
    assert.equal(status2.phase, 'Cancelled');
    assert.equal(status2.isCurrentHead, false, 'isCurrentHead must be false for cancelled run');
    assert.equal(status2.cancelRequested, true, 'cancelRequested must be true');
    assert.equal(status2.fencingEpoch, 2, 'fencingEpoch must be 2');
    assert.equal(status2.cancelReason, 'superseded_by_commit');
  });

  it('enforces fail-closed security for invalid HMAC, tampered body, and missing secret', async () => {
    const { env, mockCtx } = createEmpiricalTestEnv();
    const rawBody = JSON.stringify({ action: 'synchronize' });

    // Missing signature header
    const reqNoSig = new Request('https://operator.calltelemetry.internal/api/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request' },
      body: rawBody,
    });
    const resNoSig = await worker.fetch(reqNoSig, env, mockCtx as any);
    assert.equal(resNoSig.status, 401);

    // Mismatched signature
    const reqBadSig = new Request('https://operator.calltelemetry.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: rawBody,
    });
    const resBadSig = await worker.fetch(reqBadSig, env, mockCtx as any);
    assert.equal(resBadSig.status, 401);

    // Malformed JSON body
    const validSigBadJson = await signPayload(env.GITHUB_WEBHOOK_SECRET, 'NOT_VALID_JSON{{{');
    const reqBadJson = new Request('https://operator.calltelemetry.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': validSigBadJson,
      },
      body: 'NOT_VALID_JSON{{{',
    });
    const resBadJson = await worker.fetch(reqBadJson, env, mockCtx as any);
    assert.equal(resBadJson.status, 400);
  });

  it('guarantees saga compensating slot release even when container runner throws', async () => {
    const { env } = createEmpiricalTestEnv();
    const repoKey = 'calltelemetry/review-yeti';
    const runId = 'run_saga_failure_test';
    const prNumber = 95;

    // Failing mock runner
    const failingRunner = {
      dispatchJob: async () => {
        throw new Error('Host microVM crash / network partition');
      },
      terminateJob: async () => ({ terminated: true }),
    };

    const workflow = new ReviewJobWorkflow(env, failingRunner as any);
    const mockStep = {
      do: async (_name: string, optOrFn: any, maybeFn?: any) => {
        const fn = typeof optOrFn === 'function' ? optOrFn : maybeFn;
        return await fn();
      },
      sleep: async () => {},
    };

    let caughtError: any = null;
    try {
      await workflow.run(
        {
          payload: {
            runId,
            owner: 'calltelemetry',
            repo: 'review-yeti',
            prNumber,
            headSha: 'sha_saga_fail',
            baseSha: 'sha_base_saga',
          },
        } as any,
        mockStep as any
      );
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Workflow must throw on runner failure');

    // Assert that RepoGateDO slot is GUARANTEED to be liberated!
    const repoGateId = env.REPO_GATE.idFromName(repoKey);
    const repoGate = env.REPO_GATE.get(repoGateId);
    const status = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(status.activeCount, 0, 'Active slot must be released in finally block');
    assert.equal(status.activeJobs.length, 0);
  });
});

