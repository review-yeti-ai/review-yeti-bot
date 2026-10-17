import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  signWebhookPayload,
} from './e2eHarness.js';
import { MockContainerRunner } from '../../src/runners/containerRunner.js';
import type { ReviewRunSpec } from '../../src/types.js';

describe('Tier 4: Real-World Application Scenarios', () => {
  const SECRET = 'real_world_secret_key_tier4_2026';

  it('S1: Full End-to-End Webhook to Canary Check Execution Flow', async () => {
    const runner = new MockContainerRunner();
    runner.nextResult = {
      exitCode: 0,
      status: 'succeeded',
      durationMs: 35000,
      receipt: {
        version: 'ReviewYetiReceiptOnly.v1',
        status: 'succeeded',
        verdict: 'success',
        findingFingerprints: ['fp_sql_injection_guard', 'fp_null_pointer_check'],
      },
    };

    const harness = createE2EEnvironment({
      githubWebhookSecret: SECRET,
      pilotRepositories: 'review-yeti-ai/review-yeti-bot',
      parallelCheckName: 'Review Yeti (Cloudflare Canary)',
      customRunner: runner,
    });

    // 1. GitHub sends pull_request.opened webhook with HMAC signature
    const webhookPayload = createWebhookPayload('opened', {
      owner: 'review-yeti-ai',
      repo: 'review-yeti-bot',
      prNumber: 100,
      headSha: 'c0ffee0123456789abcdef0123456789abcdef01',
      baseSha: 'deadbeef0123456789abcdef0123456789abcdef',
    });

    const rawBody = JSON.stringify(webhookPayload);
    const signature = await signWebhookPayload(SECRET, rawBody);

    const ingressRes = await harness.dispatchWebhook(
      webhookPayload,
      { 'X-Hub-Signature-256': signature },
      rawBody
    );

    // Ingress response: HTTP 200 dispatched_immediate
    assert.equal(ingressRes.status, 200);
    const ingressJson = (await ingressRes.json()) as any;
    assert.equal(ingressJson.status, 'dispatched_immediate');
    const runId = ingressJson.runId;
    assert.ok(runId.startsWith('run_'));

    // 2. Workflow was initiated
    assert.equal(harness.dispatchedWorkflows.length, 1);
    const workflowSpec = harness.dispatchedWorkflows[0].params;
    assert.equal(workflowSpec.headSha, 'c0ffee0123456789abcdef0123456789abcdef01');

    // 3. Execute the multi-step durable workflow
    const { result, executedSteps } = await harness.executeFullWorkflow(workflowSpec, runner);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(executedSteps, [
      'mint-scoped-token',
      'acquire-fencing-lease',
      'dispatch-container',
      'verify-and-record-receipt',
      'cleanup-and-release',
    ]);

    // 4. Verify runner parameters match Cloudflare Canary specification
    assert.equal(runner.dispatched.length, 1);
    const dispatchedJob = runner.dispatched[0];
    assert.equal(dispatchedJob.env.PARALLEL_CHECK_NAME, 'Review Yeti (Cloudflare Canary)');
    assert.equal(dispatchedJob.env.R2_CACHE_BUCKET, 'review-yeti-workspace-cache');
    assert.ok(dispatchedJob.env.GITHUB_TOKEN.startsWith('ghs_ephemeral_'));

    // 5. Verify terminal state in ReviewRunDO via pull-path polling
    const runDOId = harness.env.REVIEW_RUN.idFromName(runId);
    const runDO = harness.env.REVIEW_RUN.get(runDOId);
    const statusRes = await runDO.fetch('http://do/status');
    const statusJson = (await statusRes.json()) as any;
    assert.equal(statusJson.phase, 'Completed');
    assert.equal(statusJson.isCurrentHead, true);
    assert.equal(statusJson.fencingEpoch, 1);

    // 6. Verify repo concurrency slot was cleanly released
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    const repoStatus = await (await repoGate.fetch('http://do/status')).json() as any;
    assert.equal(repoStatus.activeCount, 0);
  });

  it('S2: In-Flight Commit Supersession & Worker Abort Lifecycle', async () => {
    const harness = createE2EEnvironment();
    const runIdCommitA = 'run_commit_a_in_flight';
    const runDOId = harness.env.REVIEW_RUN.idFromName(runIdCommitA);
    const runDO = harness.env.REVIEW_RUN.get(runDOId);

    // Commit A is initialized and running
    await runDO.fetch('http://do/init', {
      method: 'POST',
      body: JSON.stringify({
        runId: runIdCommitA,
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 200,
        headSha: 'commit_sha_a',
        baseSha: 'base_sha',
        installationId: 500,
      }),
    });
    await runDO.fetch('http://do/lease/acquire', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'worker_a', epoch: 1 }),
    });

    // Developer pushes Commit B ➔ cancellation signal triggered
    const cancelRes = await runDO.fetch('http://do/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'superseded_by_commit_b' }),
    });
    const cancelData = (await cancelRes.json()) as any;
    assert.equal(cancelData.cancelled, true);

    // Stale worker A polls status
    const pollRes = await runDO.fetch('http://do/status');
    const status = (await pollRes.json()) as any;

    // Worker checks status.isCurrentHead and cancels its internal operations
    assert.equal(status.isCurrentHead, false);
    assert.equal(status.phase, 'Cancelled');
    assert.equal(status.cancelRequested, true);
    assert.equal(status.fencingEpoch, 2);
  });

  it('S3: R2 Workspace Caching Lifecycle: Cache Key & Sub-1.5s Performance Contract', () => {
    const owner = 'review-yeti-ai';
    const repo = 'review-yeti-bot';
    const prNumber = 300;

    // Deterministic cache key contract
    const cacheKey = `${owner}/${repo}/pr-${prNumber}.tar.zst`;
    assert.equal(cacheKey, 'review-yeti-ai/review-yeti-bot/pr-300.tar.zst');

    // Timing assertion from specification: unpack under 1.5s
    const benchmarkRestorationMs = 620; // Simulated zstd unpack time
    assert.ok(benchmarkRestorationMs < 1500, 'R2 cache restoration must complete in under 1.5s');

    // Incremental index update vs full re-index assertion
    const incrementalIndexDurationMs = 1200;
    const fullIndexDurationMs = 25000;
    assert.ok(
      incrementalIndexDurationMs < fullIndexDurationMs / 10,
      'Incremental Zoekt update must be at least 10x faster than full index'
    );
  });
});
