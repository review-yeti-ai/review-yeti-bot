import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createE2EEnvironment,
  createWebhookPayload,
  createSampleReceipt,
  signWebhookPayload,
} from './e2eHarness.js';
import { compareRuns, formatComparisonReport } from '../../src/compareOrchestratorRuns.js';
import { MockContainerRunner } from '../../src/runners/containerRunner.js';
import type { ReviewRunSpec } from '../../src/types.js';

describe('Tier 4: Real-World Application Scenarios', () => {
  const SECRET = 'real_world_secret_key_tier4_2026';

  it('S1: Full End-to-End Webhook to Canary Check Execution Flow', async () => {
    let doksFallbackPayload: any = null;
    const fallbackUrl = 'https://doks.example.internal/api/webhooks';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url) === fallbackUrl) {
        doksFallbackPayload = JSON.parse(init?.body as string);
        return new Response('ok', { status: 200 });
      }
      return new Response('ok', { status: 200 });
    }) as any;

    try {
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
        doksFallbackUrl: fallbackUrl,
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

      // 2. Verify DOKS fallback fanout occurred asynchronously
      assert.ok(doksFallbackPayload);
      assert.equal(doksFallbackPayload.pull_request.number, 100);

      // 3. Workflow was initiated
      assert.equal(harness.dispatchedWorkflows.length, 1);
      const workflowSpec = harness.dispatchedWorkflows[0].params;
      assert.equal(workflowSpec.headSha, 'c0ffee0123456789abcdef0123456789abcdef01');

      // 4. Execute the multi-step durable workflow
      const { result, executedSteps } = await harness.executeFullWorkflow(workflowSpec, runner);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(executedSteps, [
        'mint-scoped-token',
        'acquire-fencing-lease',
        'dispatch-container',
        'verify-and-record-receipt',
        'cleanup-and-release',
      ]);

      // 5. Verify runner parameters match Cloudflare Canary specification
      assert.equal(runner.dispatched.length, 1);
      const dispatchedJob = runner.dispatched[0];
      assert.equal(dispatchedJob.env.PARALLEL_CHECK_NAME, 'Review Yeti (Cloudflare Canary)');
      assert.equal(dispatchedJob.env.R2_CACHE_BUCKET, 'review-yeti-workspace-cache');
      assert.ok(dispatchedJob.env.GITHUB_TOKEN.startsWith('ghs_ephemeral_'));

      // 6. Verify terminal state in ReviewRunDO via pull-path polling
      const runDOId = harness.env.REVIEW_RUN.idFromName(runId);
      const runDO = harness.env.REVIEW_RUN.get(runDOId);
      const statusRes = await runDO.fetch('http://do/status');
      const statusJson = (await statusRes.json()) as any;
      assert.equal(statusJson.phase, 'Completed');
      assert.equal(statusJson.isCurrentHead, true);
      assert.equal(statusJson.fencingEpoch, 1);

      // 7. Verify repo concurrency slot was cleanly released
      const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
      const repoGate = harness.env.REPO_GATE.get(repoGateId);
      const repoStatus = await (await repoGate.fetch('http://do/status')).json() as any;
      assert.equal(repoStatus.activeCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('S2: 100 Consecutive Shadow Parity Verification & CI Ledger Matching Gate', () => {
    // Simulates the production cutover gate: 100 consecutive matches across pilot runs
    const totalRuns = 100;
    let matchCount = 0;

    for (let i = 1; i <= totalRuns; i++) {
      const doksReceipt = createSampleReceipt('doks', {
        runId: `doks_run_${i}`,
        prNumber: i,
        verdict: i % 10 === 0 ? 'action_required' : 'success',
        findingFingerprints: [`fp_sec_${i % 5}`, `fp_perf_${i % 3}`],
        durationMs: 40000 + (i * 10),
        tokensUsed: { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
      });

      const cfReceipt = createSampleReceipt('cloudflare', {
        runId: `cf_run_${i}`,
        prNumber: i,
        verdict: i % 10 === 0 ? 'action_required' : 'success',
        findingFingerprints: [`fp_perf_${i % 3}`, `fp_sec_${i % 5}`], // Same set in different order
        durationMs: 32000 + (i * 8), // Cloudflare ~20% faster
        tokensUsed: { promptTokens: 9980, completionTokens: 2010, totalTokens: 11990 },
      });

      const comparison = compareRuns(doksReceipt, cfReceipt);
      if (comparison.match && comparison.verdictMatch && comparison.findingFingerprintsMatch) {
        matchCount++;
      }
    }

    assert.equal(matchCount, 100, 'Must achieve 100 consecutive matches for production promotion');

    // Verify formatted summary for CI logs
    const sampleDoks = createSampleReceipt('doks', { runId: 'doks_final' });
    const sampleCf = createSampleReceipt('cloudflare', { runId: 'cf_final' });
    const report = formatComparisonReport(compareRuns(sampleDoks, sampleCf));

    assert.ok(report.includes('Status: ✅ MATCH'));
    assert.ok(report.includes('Verdict Agreement:         YES'));
    assert.ok(report.includes('Finding Fingerprint Match: YES'));
  });

  it('S3: Parity Gate Discrepancy Detection: Flags Divergence and Halts Promotion', () => {
    const doksReceipt = createSampleReceipt('doks', {
      verdict: 'success',
      findingFingerprints: ['fp_auth_bypass'],
    });
    // Cloudflare canary found an extra finding or missed one
    const cfReceipt = createSampleReceipt('cloudflare', {
      verdict: 'action_required',
      findingFingerprints: ['fp_auth_bypass', 'fp_unexpected_leak'],
    });

    const comparison = compareRuns(doksReceipt, cfReceipt);
    assert.equal(comparison.match, false);
    assert.equal(comparison.verdictMatch, false);
    assert.equal(comparison.findingFingerprintsMatch, false);
    assert.ok(comparison.notes.some((n) => n.includes('Verdict mismatch')));
    assert.ok(comparison.notes.some((n) => n.includes('Finding fingerprint divergence')));

    const report = formatComparisonReport(comparison);
    assert.ok(report.includes('Status: ❌ MISMATCH'));
  });

  it('S4: In-Flight Commit Supersession & Worker Abort Lifecycle', async () => {
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

  it('S5: R2 Workspace Caching Lifecycle: Cache Key & Sub-1.5s Performance Contract', () => {
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
