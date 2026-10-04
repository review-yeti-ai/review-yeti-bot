import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockContainerRunner, CloudflareContainerRunner } from '../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';
import { createMockEnv } from './mockDurableObject.js';
import type { ReviewRunSpec } from '../src/types.js';

describe('ReviewJobWorkflow Durable Execution', () => {
  const sampleSpec: ReviewRunSpec = {
    runId: 'run_wf_001',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
    installationId: 1001,
  };

  it('orchestrates complete review lifecycle and releases repo slot', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

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

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);

    assert.equal(result.runId, 'run_wf_001');
    assert.equal(result.status, 'succeeded');

    // Verify all 5 steps ran
    assert.deepEqual(executedSteps, [
      'mint-scoped-token',
      'acquire-fencing-lease',
      'dispatch-container',
      'verify-and-record-receipt',
      'cleanup-and-release',
    ]);

    // Verify container received expected parameters
    assert.equal(runner.dispatched.length, 1);
    assert.equal(runner.dispatched[0].runId, 'run_wf_001');
    assert.equal(runner.dispatched[0].prNumber, 42);
    assert.ok(runner.dispatched[0].env.GITHUB_TOKEN.startsWith('ghs_ephemeral_'));
    assert.equal(Object.hasOwn(runner.dispatched[0].env, 'DISPATCH_STATUS_URL'), false);

    // Verify slot released in RepoGateDO
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);
  });

  it('waits for concurrency slot using step.sleep and succeeds when slot becomes available', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        // Before poll-slot-1 runs, simulate prior run releasing slot
        if (name === 'poll-slot-1') {
          await repoGate.fetch('http://do/release', {
            method: 'POST',
            body: JSON.stringify({ runId: 'prior_run' }),
          });
        }
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(name: string, _duration: any) {
        executedSteps.push(name);
      },
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);
    assert.equal(result.status, 'succeeded');

    assert.ok(executedSteps.includes('acquire-fencing-lease'));
    assert.ok(executedSteps.includes('wait-for-slot-1'));
    assert.ok(executedSteps.includes('poll-slot-1'));
    assert.ok(executedSteps.includes('dispatch-container'));
    assert.ok(executedSteps.includes('cleanup-and-release'));
  });

  it('uses the explicit deployment-owned dispatch status origin', async () => {
    const env = { ...createMockEnv(), DISPATCH_STATUS_BASE_URL: 'https://operator.example.com' };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);
    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        return (typeof arg2 === 'function' ? arg2 : arg3)();
      },
      async sleep() {},
    };
    const result = await workflow.run({ payload: { ...sampleSpec, runId: 'run-status-origin' } }, mockStep as any);
    assert.equal(result.status, 'succeeded');
    assert.equal(runner.dispatched[0].env.DISPATCH_STATUS_URL, 'https://operator.example.com/api/dispatch/runs/run-status-origin/status');
  });

  it('guarantees repo slot release in finally block even if container dispatch throws', async () => {
    const env = createMockEnv();
    // Runner that throws an exception during dispatch
    const failingRunner = {
      async dispatchJob(): Promise<any> {
        throw new Error('Sandbox Firecracker microVM launch failure: Out of memory');
      },
      async terminateJob(): Promise<any> {
        return { terminated: true };
      },
    };

    const workflow = new ReviewJobWorkflow(env, failingRunner as any);
    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Sandbox Firecracker microVM launch failure/
    );

    // Assert cleanup-and-release was still executed
    assert.ok(executedSteps.includes('cleanup-and-release'));

    // Assert RepoGateDO slot is clean (activeCount === 0)
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);

    // Assert ReviewRunDO received failed terminal receipt
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    const runStatusRes = await runDO.fetch('http://do/status');
    const runStatus = (await runStatusRes.json()) as any;
    assert.equal(runStatus.phase, 'Failed');
  });

  it('guarantees repo slot release in finally block even if lease acquisition fails', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    // Pre-initialize and cancel runDO so /lease/acquire fails with cancel_requested
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    await runDO.fetch('http://do/init', { method: 'POST', body: JSON.stringify(sampleSpec) });
    await runDO.fetch('http://do/cancel', { method: 'POST', body: JSON.stringify({ reason: 'pre_cancel' }) });

    const workflow = new ReviewJobWorkflow(env, runner);
    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Lease acquisition failed/
    );

    assert.ok(executedSteps.includes('cleanup-and-release'));
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.activeCount, 0);
  });

  it('persists receipt audit record to PostgreSQL Hyperdrive gracefully', async () => {
    const env = createMockEnv();
    env.HYPERDRIVE = {
      connectionString: 'postgresql://review_yeti:secret@hyperdrive.internal:5432/review_yeti_staging',
    };
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    const result = await workflow.run({ payload: sampleSpec }, mockStep as any);
    assert.equal(result.status, 'succeeded');
    assert.ok(executedSteps.includes('verify-and-record-receipt'));
  });

  it('terminates polling loop immediately and triggers saga release when ReviewRunDO is cancelled while waiting for concurrency slot', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand with a prior run
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        // Before poll-slot-1 runs, simulate cancellation of this workflow's run in ReviewRunDO
        if (name === 'poll-slot-1') {
          const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
          await runDO.fetch('http://do/cancel', {
            method: 'POST',
            body: JSON.stringify({ reason: 'superseded_by_commit' }),
          });
        }
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(name: string, _duration: any) {
        executedSteps.push(name);
      },
    };

    await assert.rejects(
      async () => workflow.run({ payload: sampleSpec }, mockStep as any),
      /Workflow cancelled while waiting for concurrency slot/
    );

    // Verify step progression: acquire-fencing-lease, sleep, poll-slot-1, and cleanup-and-release
    assert.ok(executedSteps.includes('acquire-fencing-lease'));
    assert.ok(executedSteps.includes('wait-for-slot-1'));
    assert.ok(executedSteps.includes('poll-slot-1'));
    assert.ok(executedSteps.includes('cleanup-and-release'));

    // Assert container dispatch and receipt steps were SKIPPED
    assert.ok(!executedSteps.includes('dispatch-container'), 'dispatch-container must not run');
    assert.ok(!executedSteps.includes('verify-and-record-receipt'), 'verify-and-record-receipt must not run');
    assert.equal(runner.dispatched.length, 0);

    // Assert RepoGateDO queue was cleaned up for this runId
    const statusRes = await repoGate.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.queueLength, 0, 'Queue must be empty after saga cleanup');
  });

  it('initializes ReviewRunDO in acquire-fencing-lease so queued runs report Pending phase and isCurrentHead: true', async () => {
    const env = createMockEnv();
    const runner = new MockContainerRunner();
    const workflow = new ReviewJobWorkflow(env, runner);

    // Occupy slot beforehand
    const repoGate = env.REPO_GATE.get('review-yeti-ai/review-yeti-bot');
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'prior_run', headSha: 'abc' }),
    });

    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
      async sleep(_name: string, _duration: any) {
        // Halt workflow inside sleep to check intermediate state
        throw new Error('STOP_AT_SLEEP');
      },
    };

    try {
      await workflow.run({ payload: sampleSpec }, mockStep as any);
    } catch (err: any) {
      assert.equal(err.message, 'STOP_AT_SLEEP');
    }

    // Inspect ReviewRunDO: MUST be initialized in Pending state with isCurrentHead: true
    const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
    const statusRes = await runDO.fetch('http://do/status');
    const status = (await statusRes.json()) as any;
    assert.equal(status.phase, 'Pending');
    assert.equal(status.cancelRequested, false);
    assert.equal(status.isCurrentHead, true);
    assert.equal(status.fencingEpoch, 1);
  });

  describe('DigitalOcean Managed Agents (MARS) Runner Execution', () => {
    it('instantiates DigitalOceanAgentRunner when RUNNER_TYPE is digitalocean or mars', async () => {
      let dispatchedSessionBody: any = null;
      let authHeader = '';
      let reviewRunIdHeader = '';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr.includes('/v2/genai/agents/custom-swarm-agent/sessions')) {
          dispatchedSessionBody = JSON.parse(init.body);
          authHeader = init.headers?.Authorization;
          reviewRunIdHeader = init.headers?.['X-Review-Run-Id'];
          return new Response(
            JSON.stringify({
              id: 'sess-12345',
              status: 'succeeded',
              exit_code: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return originalFetch(input, init);
      };

      try {
        const env = {
          ...createMockEnv(),
          RUNNER_TYPE: 'digitalocean',
          DO_API_TOKEN: 'dop_v1_mock_token_12345',
          DO_AGENT_ID: 'custom-swarm-agent',
          DO_BASE_URL: 'https://api.digitalocean.com',
          PARALLEL_CHECK_NAME: 'Review Yeti',
        };

        const workflow = new ReviewJobWorkflow(env);

        // Pre-initialize ReviewRunDO with valid terminal receipt so verify step succeeds
        const runDO = env.REVIEW_RUN.get(sampleSpec.runId);
        await runDO.fetch('http://do/init', {
          method: 'POST',
          body: JSON.stringify(sampleSpec),
        });
        await runDO.fetch('http://do/lease/acquire', {
          method: 'POST',
          body: JSON.stringify({ workerId: `cf-worker-${sampleSpec.runId.slice(0, 8)}`, epoch: 1 }),
        });
        await runDO.fetch('http://do/receipt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workerId: `cf-worker-${sampleSpec.runId.slice(0, 8)}`,
            epoch: 1,
            receipt: {
              status: 'success',
              findings: [],
              verdict: 'approved',
              summary: 'Clean PR',
            },
          }),
        });

        const mockStep = {
          async do(name: string, arg2: any, arg3?: any) {
            const fn = typeof arg2 === 'function' ? arg2 : arg3;
            return fn();
          },
        };

        const result = await workflow.run({ payload: sampleSpec }, mockStep as any);

        assert.equal(result.runId, sampleSpec.runId);
        assert.equal(authHeader, 'Bearer dop_v1_mock_token_12345');
        assert.equal(reviewRunIdHeader, sampleSpec.runId);
        assert.ok(dispatchedSessionBody);
        assert.equal(dispatchedSessionBody.session_id, `job-${sampleSpec.runId}`);
        assert.equal(dispatchedSessionBody.environment.PARALLEL_CHECK_NAME, 'Review Yeti');
        assert.equal(dispatchedSessionBody.environment.RUN_ID, sampleSpec.runId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('keys runner cache by normalized runner type and allows subsequent distinct target runners', () => {
      const env = createMockEnv();
      const workflow = new ReviewJobWorkflow(env);

      const cfRunner = workflow.getRunner('cloudflare');
      assert.ok(cfRunner instanceof CloudflareContainerRunner);

      const doRunner = workflow.getRunner('digitalocean');
      assert.ok(doRunner instanceof DigitalOceanAgentRunner);

      // Verify DO alias 'mars' returns the cached DigitalOcean runner
      const marsRunner = workflow.getRunner('mars');
      assert.equal(marsRunner, doRunner);

      // Verify subsequent request for cloudflare runner returns the cached Cloudflare runner
      const cfRunner2 = workflow.getRunner('cloudflare');
      assert.equal(cfRunner2, cfRunner);
    });

    it('falls back to DigitalOcean runner in production if Containers binding is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      let doInvoked = false;
      try {
        globalThis.fetch = async (url: any) => {
          if (String(url).includes('digitalocean.com')) {
            doInvoked = true;
            return Response.json({ session_id: 'session-123', status: 'running' });
          }
          return new Response('Not Found', { status: 404 });
        };

        const env = {
          ...createMockEnv(),
          ENVIRONMENT: 'production',
          DO_API_TOKEN: 'dop_mock_token_production',
          DO_AGENT_ID: 'swarm-do-1',
        };
        const workflow = new ReviewJobWorkflow(env);
        const runner = workflow.getRunner('cloudflare') as CloudflareContainerRunner;

        assert.ok(runner instanceof CloudflareContainerRunner);

        const result = await runner.dispatchJob({
          jobId: 'job-1',
          runId: 'run-1',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'head-sha',
          baseSha: 'base-sha',
          workerImage: 'ghcr.io/test:latest',
          env: {},
        });

        assert.ok(doInvoked, 'Expected fallback to DigitalOcean agent runner');
        assert.equal(result.jobId, 'job-1');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

