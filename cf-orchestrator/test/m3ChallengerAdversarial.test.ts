import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareContainerRunner,
  type ContainerJobSpec,
} from '../src/runners/containerRunner.js';

describe('M3 Challenger Adversarial Stress Suite', () => {
  const baseSpec: ContainerJobSpec = {
    jobId: 'job_adv_001',
    runId: 'run_adv_001',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 99,
    headSha: '1111222233334444555566667777888899990000',
    baseSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
    workerImage: 'registry.example.com/review-yeti/worker:staging',
    env: {
      GITHUB_TOKEN: 'ghs_adv_secret_token',
      RUN_ID: 'run_adv_001',
      NODE_ENV: 'test',
    },
  };

  // =========================================================================
  // Section 1: CloudflareContainerRunner Adversarial Challenges
  // =========================================================================
  describe('CloudflareContainerRunner Adversarial Challenges', () => {
    describe('1.1 Container Crash with Non-Zero Exit Codes', () => {
      it('exit code 1 (general failure) maps to status failed and exitCode 1', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 1,
              error: 'Process crashed with uncaught exception',
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.equal(result.error, 'Process crashed with uncaught exception');
      });

      it('exit code 137 (SIGKILL/OOM) maps to status cancelled and exitCode 137', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 137,
              error: 'Container exceeded memory limit of 2048MB (OOMKilled)',
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'cancelled');
        assert.equal(result.exitCode, 137);
      });

      it('exit code 255 (fatal container error) maps to status failed and exitCode 255', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 255,
              error: 'Fatal container runtime exit (255)',
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 255);
      });

      it('exit code 139 (SIGSEGV segmentation fault) maps to status failed and exitCode 139', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 139,
              error: 'Segmentation fault (core dumped)',
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 139);
      });
    });

    describe('1.2 Timeouts (exit code 124, TimeoutError, string match)', () => {
      it('exit code 124 directly maps to status timed_out', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              exitCode: 124,
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
        assert.equal(result.exitCode, 124);
      });

      it('outcome.status = timed_out maps to status timed_out even if exitCode omitted', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              status: 'timed_out',
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
      });

      it('outcome.timedOut = true maps to status timed_out', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              timedOut: true,
              exitCode: 124,
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
        assert.equal(result.exitCode, 124);
      });

      it('instance.wait() rejecting with TimeoutError maps to timed_out with exitCode 124', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => {
              const err: any = new Error('Execution deadline expired after 1500s');
              err.name = 'TimeoutError';
              throw err;
            },
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
        assert.equal(result.exitCode, 124);
        assert.ok(result.error?.includes('Execution deadline expired'));
      });

      it('instance.wait() rejecting with message containing "timed out" maps to timed_out', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => {
              throw new Error('Container task timed out waiting for worker readiness');
            },
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
        assert.equal(result.exitCode, 124);
      });
    });

    describe('1.3 Cancellations (exit code 137, AbortError, instance termination)', () => {
      it('outcome.status = cancelled maps to status cancelled', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              status: 'cancelled',
              exitCode: 137,
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'cancelled');
        assert.equal(result.exitCode, 137);
      });

      it('outcome.cancelled = true maps to status cancelled', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => ({
              cancelled: true,
              exitCode: 137,
            }),
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'cancelled');
        assert.equal(result.exitCode, 137);
      });

      it('instance.wait() rejecting with AbortError maps to cancelled with exitCode 137', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => {
              const err: any = new Error('Execution was aborted by parent workflow');
              err.name = 'AbortError';
              throw err;
            },
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'cancelled');
        assert.equal(result.exitCode, 137);
        assert.ok(result.error?.includes('aborted'));
      });

      it('instance.wait() rejecting with message containing "terminated" maps to cancelled', async () => {
        const mockBinding = {
          create: async () => ({
            wait: async () => {
              throw new Error('Worker container was terminated by operator');
            },
          }),
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'cancelled');
        assert.equal(result.exitCode, 137);
      });
    });

    describe('1.4 Missing / Failing containersBinding', () => {
      it('fails cleanly with diagnostic message when binding is undefined', async () => {
        const runner = new CloudflareContainerRunner(undefined);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes('Cloudflare Containers binding unavailable: create method not found on binding'));
      });

      it('fails cleanly with diagnostic message when binding is null', async () => {
        const runner = new CloudflareContainerRunner(null);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes('Cloudflare Containers binding unavailable: create method not found on binding'));
      });

      it('fails cleanly when binding is empty object lacking create method', async () => {
        const runner = new CloudflareContainerRunner({});
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes('Cloudflare Containers binding unavailable: create method not found on binding'));
      });

      it('fails cleanly when containersBinding.create throws synchronous exception', async () => {
        const mockBinding = {
          create: () => {
            throw new Error('Synchronous binding failure: invalid credentials');
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes('Synchronous binding failure'));
      });

      it('fails cleanly with failed status when containersBinding.create rejects asynchronously with network error', async () => {
        const mockBinding = {
          create: async () => {
            throw new Error('Cloudflare network unreachable: ECONNREFUSED');
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'failed');
        assert.equal(result.exitCode, 1);
        assert.ok(result.error?.includes('ECONNREFUSED'));
      });

      it('maps to timed_out when containersBinding.create rejects with timeout message', async () => {
        const mockBinding = {
          create: async () => {
            throw new Error('Cloudflare network unreachable: DNS timeout');
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);
        const result = await runner.dispatchJob(baseSpec);

        assert.equal(result.status, 'timed_out');
        assert.equal(result.exitCode, 124);
        assert.ok(result.error?.includes('DNS timeout'));
      });
    });

    describe('1.5 Concurrent Container Dispatches & Instance-Level Termination', () => {
      it('tracks multiple concurrent instances and selectively terminates targeted jobs without cross-contamination', async () => {
        const activeInstances = new Map<string, { terminatedReason?: string; resolveWait: (val: any) => void }>();

        const mockBinding = {
          create: async (opts: any) => {
            const jobId = opts.env.RUN_ID;
            let resolveWait: any;
            const waitPromise = new Promise((resolve) => {
              resolveWait = resolve;
            });

            const instance = {
              wait: () => waitPromise,
              terminate: async (termOpts: any) => {
                const entry = activeInstances.get(jobId);
                if (entry) {
                  entry.terminatedReason = termOpts?.reason;
                }
              },
            };

            activeInstances.set(jobId, { resolveWait });
            return instance;
          },
        };

        const runner = new CloudflareContainerRunner(mockBinding);

        // Launch 5 concurrent jobs
        const jobSpecs: ContainerJobSpec[] = [0, 1, 2, 3, 4].map((i) => ({
          ...baseSpec,
          jobId: `concurrent_job_${i}`,
          runId: `run_concurrent_${i}`,
          env: { ...baseSpec.env, RUN_ID: `concurrent_job_${i}` },
        }));

        const dispatchPromises = jobSpecs.map((spec) => runner.dispatchJob(spec));

        // Wait a tick for all jobs to enter create and register in runner.activeJobs
        await new Promise((r) => setTimeout(r, 20));

        // Target job_1 and job_3 for termination with specific reasons
        const term1 = await runner.terminateJob('concurrent_job_1', 'superseded_by_commit_new');
        const term3 = await runner.terminateJob('concurrent_job_3', 'pr_closed_by_author');

        assert.equal(term1.terminated, true);
        assert.equal(term3.terminated, true);

        // Verify that instances 1 and 3 received the termination call
        assert.equal(activeInstances.get('concurrent_job_1')?.terminatedReason, 'superseded_by_commit_new');
        assert.equal(activeInstances.get('concurrent_job_3')?.terminatedReason, 'pr_closed_by_author');

        // Verify that instances 0, 2, 4 did NOT receive any termination
        assert.equal(activeInstances.get('concurrent_job_0')?.terminatedReason, undefined);
        assert.equal(activeInstances.get('concurrent_job_2')?.terminatedReason, undefined);
        assert.equal(activeInstances.get('concurrent_job_4')?.terminatedReason, undefined);

        // Resolve active jobs accordingly
        activeInstances.get('concurrent_job_1')?.resolveWait({ exitCode: 137, status: 'cancelled' });
        activeInstances.get('concurrent_job_3')?.resolveWait({ exitCode: 137, status: 'cancelled' });
        activeInstances.get('concurrent_job_0')?.resolveWait({ exitCode: 0, status: 'succeeded' });
        activeInstances.get('concurrent_job_2')?.resolveWait({ exitCode: 0, status: 'succeeded' });
        activeInstances.get('concurrent_job_4')?.resolveWait({ exitCode: 0, status: 'succeeded' });

        const results = await Promise.all(dispatchPromises);

        assert.equal(results[0].status, 'succeeded');
        assert.equal(results[1].status, 'cancelled');
        assert.equal(results[2].status, 'succeeded');
        assert.equal(results[3].status, 'cancelled');
        assert.equal(results[4].status, 'succeeded');
      });
    });
  });
});
