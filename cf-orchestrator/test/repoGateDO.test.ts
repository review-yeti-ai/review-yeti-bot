import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RepoGateDO } from '../src/repoGateDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';

describe('RepoGateDO Concurrency Gate & PR Active Mapping', () => {
  // 1. Basic concurrency
  it('grants slot when concurrency limit is not exceeded', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    const res1 = await gate.acquireSlot('run_1', 'sha_1', 101);
    assert.equal(res1.granted, true);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.deepEqual(status.activeJobs, ['run_1']);
    assert.equal(gate.getActiveRun(101), 'run_1');
  });

  // 2. Queueing
  it('queues subsequent run when concurrency slot is occupied', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_1', 'sha_1', 101);

    const res2 = await gate.acquireSlot('run_2', 'sha_2', 102);
    assert.equal(res2.granted, false);
    assert.equal(res2.queuePosition, 1);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.equal(status.queueLength, 1);
    // run_2 is pending, so active run for 102 should be undefined
    assert.equal(gate.getActiveRun(102), undefined);
  });

  // 3. Dequeueing and promotion
  it('dequeues next run and promotes PR mapping when active slot is released', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_1', 'sha_1', 101);
    await gate.acquireSlot('run_2', 'sha_2', 102);

    const releaseRes = await gate.releaseSlot('run_1');
    assert.equal(releaseRes.released, true);
    assert.equal(releaseRes.nextRunId, 'run_2');

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.deepEqual(status.activeJobs, ['run_2']);
    assert.equal(status.queueLength, 0);

    // Old PR mapping cleared, new PR mapping active
    assert.equal(gate.getActiveRun(101), undefined);
    assert.equal(gate.getActiveRun(102), 'run_2');
  });

  // 4. Duplicate acquire for active run
  it('handles duplicate acquireSlot for already active run idempotently', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    const res1 = await gate.acquireSlot('run_1', 'sha_1', 101);
    assert.equal(res1.granted, true);

    const res2 = await gate.acquireSlot('run_1', 'sha_1', 101);
    assert.equal(res2.granted, true);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
  });

  // 5. Release on empty queue cleans up PR mapping
  it('cleans up PR mapping when active run is released with empty queue', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_1', 'sha_1', 101);
    assert.equal(gate.getActiveRun(101), 'run_1');

    const releaseRes = await gate.releaseSlot('run_1');
    assert.equal(releaseRes.released, true);
    assert.equal(releaseRes.nextRunId, undefined);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 0);
    assert.equal(gate.getActiveRun(101), undefined);
  });

  // 6. Release of non-active run
  it('returns released: false when releasing a non-active run', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_1', 'sha_1', 101);
    const releaseRes = await gate.releaseSlot('run_nonexistent');
    assert.equal(releaseRes.released, false);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.equal(gate.getActiveRun(101), 'run_1');
  });

  // 7. Release of queued run evicts it
  it('evicts queued run when releaseSlot is called on pending runId', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_1', 'sha_1', 101);
    await gate.acquireSlot('run_2', 'sha_2', 102);

    const releaseRes = await gate.releaseSlot('run_2');
    assert.equal(releaseRes.released, false);

    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.equal(status.queueLength, 0);
  });

  // 8. Queue eviction on superseding commit for same PR
  it('evicts stale queued commit when a newer commit arrives for the same PR', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    // run_1 is active for PR 101
    await gate.acquireSlot('run_1', 'sha_1', 101);

    // Commit A for PR 102 is queued
    const q1 = await gate.acquireSlot('run_102_A', 'sha_A', 102);
    assert.equal(q1.granted, false);
    assert.equal(q1.queuePosition, 1);

    // Commit B arrives for PR 102 (supersedes Commit A)
    const q2 = await gate.acquireSlot('run_102_B', 'sha_B', 102);
    assert.equal(q2.granted, false);
    assert.equal(q2.queuePosition, 1);

    const status = await gate.getStatus();
    assert.equal(status.queueLength, 1);

    // When run_1 releases, run_102_B should be dequeued, NOT run_102_A
    const rel = await gate.releaseSlot('run_1');
    assert.equal(rel.released, true);
    assert.equal(rel.nextRunId, 'run_102_B');
    assert.equal(gate.getActiveRun(102), 'run_102_B');
  });

  // 9. HTTP GET /active-run/:prNumber
  it('HTTP GET /active-run/:prNumber returns activeRunId or null', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_http', 'sha_http', 42);

    // Active PR
    const resFound = await gate.fetch(new Request('http://do/active-run/42'));
    assert.equal(resFound.status, 200);
    const dataFound = (await resFound.json()) as any;
    assert.equal(dataFound.activeRunId, 'run_http');

    // Inactive PR
    const resMissing = await gate.fetch(new Request('http://do/active-run/999'));
    assert.equal(resMissing.status, 200);
    const dataMissing = (await resMissing.json()) as any;
    assert.equal(dataMissing.activeRunId, null);

    // Invalid non-numeric PR
    const resBad = await gate.fetch(new Request('http://do/active-run/abc'));
    assert.equal(resBad.status, 400);
  });

  // 10. HTTP POST /evict
  it('HTTP POST /evict removes queued entries by PR number or runId', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_active', 'sha_0', 1);
    await gate.acquireSlot('run_q1', 'sha_1', 2);
    await gate.acquireSlot('run_q2', 'sha_2', 3);

    const evictRes = await gate.fetch(
      new Request('http://do/evict', {
        method: 'POST',
        body: JSON.stringify({ prNumber: 2 }),
      })
    );
    assert.equal(evictRes.status, 200);
    const evictData = (await evictRes.json()) as any;
    assert.equal(evictData.evicted, true);
    assert.equal(evictData.count, 1);

    const status = await gate.getStatus();
    assert.equal(status.queueLength, 1);
  });

  // 11. State persistence across DO reboots
  it('persists and recovers activeJobs, queue, and activeRunsByPr across DO restart', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};

    // First instance
    const gate1 = new RepoGateDO(state as any, env);
    await gate1.acquireSlot('run_persist_1', 'sha_p1', 55);
    await gate1.acquireSlot('run_persist_2', 'sha_p2', 56);

    // Reboot DO with identical storage
    const gate2 = new RepoGateDO(state as any, env);
    const status = await gate2.getStatus();

    assert.equal(status.activeCount, 1);
    assert.deepEqual(status.activeJobs, ['run_persist_1']);
    assert.equal(status.queueLength, 1);
    assert.equal(gate2.getActiveRun(55), 'run_persist_1');
  });

  // 12. HTTP 404 on unmapped route
  it('returns HTTP 404 on unknown route', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    const res = await gate.fetch(new Request('http://do/unknown-endpoint'));
    assert.equal(res.status, 404);
  });

  // 13. Re-polling while queued maintains queue position and does not evict anything
  it('maintains queue position and FIFO order when queued runs re-poll during waiting loop', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    // Active slot occupied
    await gate.acquireSlot('run_active', 'sha_active', 100);

    // PR 101 enqueued at position 1
    const q1 = await gate.acquireSlot('run_pr101', 'sha_101_v1', 101);
    assert.equal(q1.granted, false);
    assert.equal(q1.queuePosition, 1);

    // PR 102 enqueued at position 2
    const q2 = await gate.acquireSlot('run_pr102', 'sha_102_v1', 102);
    assert.equal(q2.granted, false);
    assert.equal(q2.queuePosition, 2);

    // PR 101 re-polls (simulating step.sleep loop in reviewJobWorkflow)
    const repoll1 = await gate.acquireSlot('run_pr101', 'sha_101_v1', 101);
    assert.equal(repoll1.granted, false);
    assert.equal(repoll1.queuePosition, 1, 'run_pr101 must remain at position 1');

    // PR 102 re-polls
    const repoll2 = await gate.acquireSlot('run_pr102', 'sha_102_v1', 102);
    assert.equal(repoll2.granted, false);
    assert.equal(repoll2.queuePosition, 2, 'run_pr102 must remain at position 2');

    // Verify queue length and order
    const status = await gate.getStatus();
    assert.equal(status.queueLength, 2);

    // When active run releases, run_pr101 must be dequeued first, NOT run_pr102
    const rel1 = await gate.releaseSlot('run_active');
    assert.equal(rel1.released, true);
    assert.equal(rel1.nextRunId, 'run_pr101');
    assert.equal(gate.getActiveRun(101), 'run_pr101');

    // When run_pr101 releases, run_pr102 is next
    const rel2 = await gate.releaseSlot('run_pr101');
    assert.equal(rel2.released, true);
    assert.equal(rel2.nextRunId, 'run_pr102');
    assert.equal(gate.getActiveRun(102), 'run_pr102');
  });

  // 14. Stale commit repoll after supersession does not resurrect or evict newer commit
  it('prevents stale superseded commit from resurrecting or evicting newer commit on re-poll', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_active', 'sha_active', 100);

    // Commit A for PR 200 enqueued
    await gate.acquireSlot('run_200_A', 'sha_A', 200);

    // Commit B for PR 200 arrives (supersedes Commit A)
    const qB = await gate.acquireSlot('run_200_B', 'sha_B', 200);
    assert.equal(qB.granted, false);
    assert.equal(qB.queuePosition, 1);

    // Commit A wakes up and re-polls acquireSlot
    const stalePoll = await gate.acquireSlot('run_200_A', 'sha_A', 200);
    assert.equal(stalePoll.granted, false);

    // Verify that Commit B is still at position 1 and Commit A was NOT resurrected
    const status = await gate.getStatus();
    assert.equal(status.queueLength, 1);

    const rel = await gate.releaseSlot('run_active');
    assert.equal(rel.released, true);
    assert.equal(rel.nextRunId, 'run_200_B', 'Commit B must be dequeued, Commit A must never run');
  });

  // 15. Explicit POST /evict marks runs as evicted and prevents re-queueing
  it('prevents runs evicted via POST /evict from re-entering the queue on re-poll', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    await gate.acquireSlot('run_active', 'sha_active', 100);
    await gate.acquireSlot('run_pr300', 'sha_300', 300);

    // Explicitly evict PR 300 (e.g. PR closed or converted to draft)
    const evictRes = await gate.fetch(
      new Request('http://do/evict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prNumber: 300 }),
      })
    );
    assert.equal(evictRes.status, 200);
    const evictData = (await evictRes.json()) as any;
    assert.equal(evictData.evicted, true);
    assert.equal(evictData.count, 1);

    // Stale workflow attempt to re-poll after eviction
    const repoll = await gate.acquireSlot('run_pr300', 'sha_300', 300);
    assert.equal(repoll.granted, false);

    const status = await gate.getStatus();
    assert.equal(status.queueLength, 0, 'Queue must remain empty after evicted run re-polls');
  });

  // 16. Defensive JSON parsing on HTTP endpoints
  it('returns HTTP 400 Bad Request on malformed JSON body to POST endpoints', async () => {
    const state = new MockDurableObjectState();
    const env: any = {};
    const gate = new RepoGateDO(state as any, env);

    const endpoints = ['/acquire', '/release', '/evict'];
    for (const ep of endpoints) {
      const res = await gate.fetch(
        new Request(`http://do${ep}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not-valid-json{',
        })
      );
      assert.equal(res.status, 400, `Expected 400 for ${ep} on malformed JSON`);
    }
  });

  // 17. Configurable concurrency limit (MAX_CONCURRENT_JOBS = 5)
  it('respects MAX_CONCURRENT_JOBS = 5 allowing 5 concurrent jobs before queueing', async () => {
    const state = new MockDurableObjectState();
    const env: any = { MAX_CONCURRENT_JOBS: '5' };
    const gate = new RepoGateDO(state as any, env);

    // Acquire 5 slots for 5 different PRs - all should be granted
    for (let i = 1; i <= 5; i++) {
      const res = await gate.acquireSlot(`run_${i}`, `sha_${i}`, 200 + i);
      assert.equal(res.granted, true, `run_${i} should be granted when concurrency limit is 5`);
    }

    const status5 = await gate.getStatus();
    assert.equal(status5.activeCount, 5);
    assert.equal(status5.queueLength, 0);

    // 6th run should be queued at position 1
    const res6 = await gate.acquireSlot('run_6', 'sha_6', 206);
    assert.equal(res6.granted, false);
    assert.equal(res6.queuePosition, 1);

    const status6 = await gate.getStatus();
    assert.equal(status6.activeCount, 5);
    assert.equal(status6.queueLength, 1);

    // Release 1 active job -> run_6 should be promoted
    const releaseRes = await gate.releaseSlot('run_1');
    assert.equal(releaseRes.released, true);
    assert.equal(releaseRes.nextRunId, 'run_6');

    const statusAfter = await gate.getStatus();
    assert.equal(statusAfter.activeCount, 5);
    assert.equal(statusAfter.queueLength, 0);
  });
});

