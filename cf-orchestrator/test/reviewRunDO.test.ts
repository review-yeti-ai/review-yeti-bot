import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import type { ReviewRunSpec } from '../src/types.js';

describe('ReviewRunDO Coordinator & Fencing', () => {
  const sampleSpec: ReviewRunSpec = {
    runId: 'run_123',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
    installationId: 1001,
  };

  it('initializes in Pending phase with fencingEpoch 1', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);

    const init = await runDO.initialize(sampleSpec);
    assert.equal(init.phase, 'Pending');
    assert.equal(init.fencingEpoch, 1);
    assert.equal(init.cancelRequested, false);
  });

  it('acquires worker lease matching fencingEpoch', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);

    const leaseRes = await runDO.acquireWorkerLease('worker_1', 1, 30_000, 'job_123');
    assert.equal(leaseRes.ok, true);
    assert.ok(leaseRes.leaseExpiresAt! > Date.now());

    const status = await runDO.getStatus();
    assert.equal(status.phase, 'Running');
    assert.equal(status.isCurrentHead, true);
    assert.equal(status.workerId, 'worker_1');
    assert.equal(status.jobId, 'job_123');
  });

  it('rejects lease acquisition with epoch mismatch', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);

    const leaseRes = await runDO.acquireWorkerLease('stale_worker', 99);
    assert.equal(leaseRes.ok, false);
    assert.equal(leaseRes.reason, 'fencing_epoch_mismatch');
  });

  it('rejects lease acquisition when run is cancelled', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.requestCancellation('superseded');

    const leaseRes = await runDO.acquireWorkerLease('worker_1', 1);
    assert.equal(leaseRes.ok, false);
    assert.equal(leaseRes.reason, 'cancel_requested');
  });

  it('rejects lease acquisition if active lease is held by another worker', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1, 60_000);

    const rivalRes = await runDO.acquireWorkerLease('worker_2', 1);
    assert.equal(rivalRes.ok, false);
    assert.equal(rivalRes.reason, 'lease_already_held');
  });

  it('cancellation bumps fencingEpoch and marks isCurrentHead false', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);

    const cancelRes = await runDO.requestCancellation('pr_closed');
    assert.equal(cancelRes.cancelled, true);

    const status = await runDO.getStatus();
    assert.equal(status.phase, 'Cancelled');
    assert.equal(status.cancelRequested, true);
    assert.equal(status.isCurrentHead, false);
    assert.equal(status.fencingEpoch, 2);

    // Stale worker lease heartbeat should fail now
    const hb = await runDO.heartbeat('worker_1', 1);
    assert.equal(hb.ok, false);
  });

  it('cancellation is idempotent and does not repeatedly bump epoch', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);

    const cancel1 = await runDO.requestCancellation('commit_superseded');
    assert.equal(cancel1.cancelled, true);
    assert.equal(cancel1.fencingEpoch, 2);

    const cancel2 = await runDO.requestCancellation('commit_superseded_again');
    assert.equal(cancel2.cancelled, true);
    assert.equal(cancel2.fencingEpoch, 2);
  });

  it('extends lease on valid worker heartbeat', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    const lease = await runDO.acquireWorkerLease('worker_1', 1, 10_000);

    const hb = await runDO.heartbeat('worker_1', 1, 30_000);
    assert.equal(hb.ok, true);
    assert.ok(hb.leaseExpiresAt! > lease.leaseExpiresAt!);
  });

  it('rejects heartbeat with wrong workerId or mismatched epoch', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);

    const hbWrongWorker = await runDO.heartbeat('imposter_worker', 1);
    assert.equal(hbWrongWorker.ok, false);
    assert.equal(hbWrongWorker.reason, 'worker_id_mismatch');

    const hbWrongEpoch = await runDO.heartbeat('worker_1', 99);
    assert.equal(hbWrongEpoch.ok, false);
    assert.equal(hbWrongEpoch.reason, 'fencing_epoch_mismatch');
  });

  it('accepts terminal receipt and transitions phase to Completed', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);

    const receipt = {
      orchestrator: 'cloudflare',
      runId: 'run_123',
      verdict: 'success',
      status: 'succeeded',
      findingFingerprints: ['fp_001'],
      durationMs: 42000,
      completedAt: new Date().toISOString(),
    };

    const res = await runDO.submitReceipt(receipt, 1);
    assert.equal(res.accepted, true);

    const status = await runDO.getStatus();
    assert.equal(status.phase, 'Completed');
  });

  it('rejects receipt submission on cancelled run or epoch mismatch', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);
    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);
    await runDO.requestCancellation('pr_closed');

    const receipt = { status: 'succeeded', verdict: 'success' };
    const res = await runDO.submitReceipt(receipt, 1);
    assert.equal(res.accepted, false);
    assert.equal(res.reason, 'run_cancelled');
  });

  it('supports HTTP fetch interface routes', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const runDO = new ReviewRunDO(state as any, env);

    const initReq = new Request('http://do/init', {
      method: 'POST',
      body: JSON.stringify(sampleSpec),
    });
    const initRes = await runDO.fetch(initReq);
    assert.equal(initRes.status, 200);

    const statusReq = new Request('http://do/status');
    const statusRes = await runDO.fetch(statusReq);
    const statusData = (await statusRes.json()) as any;
    assert.equal(statusData.phase, 'Pending');
    assert.equal(statusData.fencingEpoch, 1);
  });
});

