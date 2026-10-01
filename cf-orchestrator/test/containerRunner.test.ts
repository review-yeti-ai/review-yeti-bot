import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareContainerRunner,
  MockContainerRunner,
  type ContainerJobSpec,
  type ContainerRunner,
} from '../src/runners/containerRunner.js';

describe('CloudflareContainerRunner Unit & Contract Suite', () => {
  const sampleSpec: ContainerJobSpec = {
    jobId: 'job_cf_100',
    runId: 'run_cf_100',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 42,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
    workerImage: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
    env: {
      GITHUB_TOKEN: 'ghs_mock_token_123',
      RUN_ID: 'run_cf_100',
      PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
    },
  };

  describe('Happy Path Dispatch', () => {
    it('dispatches container job with default resource limits (cpu: 2, memory: 2048MB, timeout: 1500)', async () => {
      let createOptionsCaptured: any = null;

      const mockBinding = {
        create: async (opts: any) => {
          createOptionsCaptured = opts;
          return {
            wait: async () => ({
              exitCode: 0,
              status: 'succeeded',
              receipt: {
                version: 'ReviewYetiReceiptOnly.v1',
                status: 'succeeded',
                runId: 'run_cf_100',
                verdict: 'APPROVED',
              },
            }),
          };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.jobId, 'job_cf_100');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.exitCode, 0);
      assert.ok(result.durationMs >= 0);
      assert.equal(result.receipt?.verdict, 'APPROVED');

      // Verify dispatched options passed to binding
      assert.equal(createOptionsCaptured.image, sampleSpec.workerImage);
      assert.equal(createOptionsCaptured.cpu, 2);
      assert.equal(createOptionsCaptured.memory, '2048MB');
      assert.equal(createOptionsCaptured.timeout, 1500);
      assert.equal(createOptionsCaptured.env.GITHUB_TOKEN, 'ghs_mock_token_123');
    });

    it('respects custom cpu, memoryMb, and timeoutSeconds passed in spec', async () => {
      let createOptionsCaptured: any = null;

      const mockBinding = {
        create: async (opts: any) => {
          createOptionsCaptured = opts;
          return {
            wait: async () => ({ exitCode: 0, status: 'succeeded' }),
          };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const customSpec: ContainerJobSpec = {
        ...sampleSpec,
        cpu: 4,
        memoryMb: 4096,
        timeoutSeconds: 600,
      };

      const result = await runner.dispatchJob(customSpec);
      assert.equal(result.status, 'succeeded');
      assert.equal(createOptionsCaptured.cpu, 4);
      assert.equal(createOptionsCaptured.memory, '4096MB');
      assert.equal(createOptionsCaptured.timeout, 600);
    });

    it('captures outputLog from container outcome', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({
            exitCode: 0,
            status: 'succeeded',
            outputLog: 'Review Yeti worker finished with 0 findings in 12.4s',
          }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'succeeded');
      assert.equal(result.outputLog, 'Review Yeti worker finished with 0 findings in 12.4s');
    });

    it('parses stringified receipt JSON if returned as a string', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({
            exitCode: 0,
            status: 'succeeded',
            receipt: JSON.stringify({
              version: 'ReviewYetiReceiptOnly.v1',
              status: 'succeeded',
              runId: 'run_cf_100',
              verdict: 'CHANGES_REQUESTED',
            }),
          }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'succeeded');
      assert.equal(typeof result.receipt, 'object');
      assert.equal(result.receipt.verdict, 'CHANGES_REQUESTED');
    });
  });

  describe('Binding Failure & Misconfiguration', () => {
    it('fails cleanly when containersBinding is undefined or missing create method', async () => {
      const runnerWithoutBinding = new CloudflareContainerRunner(undefined);
      const res1 = await runnerWithoutBinding.dispatchJob(sampleSpec);

      assert.equal(res1.status, 'failed');
      assert.equal(res1.exitCode, 1);
      assert.ok(res1.error?.includes('binding unavailable'));

      const runnerWithInvalidBinding = new CloudflareContainerRunner({ invalid: true });
      const res2 = await runnerWithInvalidBinding.dispatchJob(sampleSpec);

      assert.equal(res2.status, 'failed');
      assert.equal(res2.exitCode, 1);
      assert.ok(res2.error?.includes('binding unavailable'));
    });

    it('handles containersBinding.create() throwing synchronous or asynchronous error', async () => {
      const mockBinding = {
        create: async () => {
          throw new Error('Cloudflare Containers API Error: Quota exceeded (max 10 active containers)');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('Quota exceeded'));
    });

    it('handles instance.wait() rejecting with host runtime crash', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => {
            throw new Error('Container host disconnected unexpectedly (SIGBUS)');
          },
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('SIGBUS'));
    });
  });

  describe('Timeout Handling & Exit Code Mapping', () => {
    it('maps outcome with status timed_out or timedOut: true to status timed_out with exitCode 124', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({
            exitCode: 124,
            status: 'timed_out',
            timedOut: true,
          }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
    });

    it('maps exit code 124 to status timed_out even if status field is omitted', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({ exitCode: 124 }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
    });

    it('catches TimeoutError and maps to status timed_out with exitCode 124', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => {
            const err: any = new Error('Container execution exceeded timeout deadline of 1500s');
            err.name = 'TimeoutError';
            throw err;
          },
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
      assert.ok(result.error?.includes('timeout deadline'));
    });

    it('maps non-zero exit code (e.g. 1, 2) to status failed', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({ exitCode: 2, error: 'Compiler error in user code' }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 2);
    });
  });

  describe('Cancellation & Termination Propagation', () => {
    it('maps exit code 137 (SIGKILL) or cancelled status to status cancelled', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => ({
            exitCode: 137,
            status: 'cancelled',
            cancelled: true,
          }),
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 137);
    });

    it('catches AbortError / cancellation error and maps to status cancelled with exitCode 137', async () => {
      const mockBinding = {
        create: async () => ({
          wait: async () => {
            const err: any = new Error('Execution cancelled due to commit supersession');
            err.name = 'AbortError';
            throw err;
          },
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 137);
      assert.ok(result.error?.includes('supersession'));
    });

    it('terminates job via binding.terminate with default reason superseded_or_closed', async () => {
      let terminatedJobId = '';
      let terminatedOptions: any = null;

      const mockBinding = {
        terminate: async (jobId: string, opts: any) => {
          terminatedJobId = jobId;
          terminatedOptions = opts;
          return { ok: true };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const res = await runner.terminateJob('job_cf_100');

      assert.equal(res.terminated, true);
      assert.equal(terminatedJobId, 'job_cf_100');
      assert.equal(terminatedOptions.reason, 'superseded_or_closed');
    });

    it('terminates job via binding.terminate with explicit custom reason', async () => {
      let terminatedOptions: any = null;

      const mockBinding = {
        terminate: async (_jobId: string, opts: any) => {
          terminatedOptions = opts;
          return { ok: true };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const res = await runner.terminateJob('job_cf_100', 'pr_converted_to_draft');

      assert.equal(res.terminated, true);
      assert.equal(terminatedOptions.reason, 'pr_converted_to_draft');
    });

    it('calls instance.terminate when an active running container instance is tracked', async () => {
      let instanceTerminatedReason = '';
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async (opts: any) => {
            instanceTerminatedReason = opts.reason;
          },
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      // Give event loop tick to enter create and register active job
      await new Promise((r) => setTimeout(r, 10));

      const termRes = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_commit');
      assert.equal(termRes.terminated, true);
      assert.equal(instanceTerminatedReason, 'superseded_by_commit');

      // Unblock wait
      waitResolve({ exitCode: 137, status: 'cancelled' });
      const finalResult = await dispatchPromise;
      assert.equal(finalResult.status, 'cancelled');
    });

    it('returns { terminated: false } when binding.terminate throws an unexpected error', async () => {
      const mockBinding = {
        terminate: async () => {
          throw new Error('Cloudflare network unreachable');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const res = await runner.terminateJob('job_fail');
      assert.equal(res.terminated, false);
    });

    it('returns { terminated: true } when activeInstance.terminate succeeds even if binding.terminate throws (Two-Tier Fix)', async () => {
      let instanceTerminatedCalled = false;
      let bindingTerminatedCalled = false;
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            instanceTerminatedCalled = true;
          },
        }),
        terminate: async () => {
          bindingTerminatedCalled = true;
          throw new Error('Cloudflare Containers binding RPC failure');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      // Allow job to register as active in runner.activeJobs
      await new Promise((r) => setTimeout(r, 10));

      const res = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_commit');
      assert.equal(res.terminated, true);
      assert.equal(instanceTerminatedCalled, true);
      assert.equal(bindingTerminatedCalled, true);

      waitResolve({ exitCode: 137, status: 'cancelled' });
      await dispatchPromise;
    });

    it('returns { terminated: true } when activeInstance.terminate fails but binding.terminate succeeds', async () => {
      let instanceTerminatedCalled = false;
      let bindingTerminatedCalled = false;
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            instanceTerminatedCalled = true;
            throw new Error('Instance handle already detached');
          },
        }),
        terminate: async () => {
          bindingTerminatedCalled = true;
          return { ok: true };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      await new Promise((r) => setTimeout(r, 10));

      const res = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_commit');
      assert.equal(res.terminated, true);
      assert.equal(instanceTerminatedCalled, true);
      assert.equal(bindingTerminatedCalled, true);

      waitResolve({ exitCode: 137, status: 'cancelled' });
      await dispatchPromise;
    });

    it('returns { terminated: false } when activeInstance.terminate fails AND binding.terminate fails', async () => {
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            throw new Error('Instance termination failed');
          },
        }),
        terminate: async () => {
          throw new Error('Binding termination failed');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      await new Promise((r) => setTimeout(r, 10));

      const res = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_commit');
      assert.equal(res.terminated, false);

      waitResolve({ exitCode: 1, status: 'failed' });
      await dispatchPromise;
    });

    it('returns { terminated: false } when activeInstance.terminate fails and binding has no terminate method', async () => {
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            throw new Error('Instance termination failed');
          },
        }),
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      await new Promise((r) => setTimeout(r, 10));

      const res = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_commit');
      assert.equal(res.terminated, false);

      waitResolve({ exitCode: 1, status: 'failed' });
      await dispatchPromise;
    });
  });

  describe('MockContainerRunner', () => {
    it('records dispatched specs and honors nextResult overrides', async () => {
      const mock = new MockContainerRunner();
      mock.nextResult = {
        status: 'failed',
        exitCode: 1,
        error: 'Simulated mock error',
      };

      const result = await mock.dispatchJob(sampleSpec);

      assert.equal(mock.dispatched.length, 1);
      assert.equal(mock.dispatched[0].jobId, 'job_cf_100');
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.equal(result.error, 'Simulated mock error');
    });

    it('records terminated jobIds and returns { terminated: true }', async () => {
      const mock = new MockContainerRunner();
      const res = await mock.terminateJob('job_mock_99');

      assert.equal(res.terminated, true);
      assert.deepEqual(mock.terminated, ['job_mock_99']);
    });
  });

  describe('Polymorphic ContainerRunner Contract', () => {
    it('allows CloudflareContainerRunner and MockContainerRunner to be used polymorphically', async () => {
      async function executeHarness(runner: ContainerRunner) {
        return await runner.dispatchJob(sampleSpec);
      }

      const mockBinding = {
        create: async () => ({
          wait: async () => ({ exitCode: 0, status: 'succeeded' }),
        }),
      };

      const cfRunner = new CloudflareContainerRunner(mockBinding);
      const mockRunner = new MockContainerRunner();

      const resCF = await executeHarness(cfRunner);
      const resMock = await executeHarness(mockRunner);

      assert.equal(resCF.status, 'succeeded');
      assert.equal(resMock.status, 'succeeded');
    });
  });
});
