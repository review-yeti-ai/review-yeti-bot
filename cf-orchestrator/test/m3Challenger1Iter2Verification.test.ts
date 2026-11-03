import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareContainerRunner } from '../src/runners/containerRunner.js';
import type { ContainerJobSpec } from '../src/runners/containerRunner.js';

const sampleSpec: ContainerJobSpec = {
  jobId: 'job_challenger_iter2_001',
  runId: 'run_challenger_iter2_001',
  owner: 'exampleorg',
  repo: 'reviewyeti',
  prNumber: 42,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  baseSha: 'abcdef0123456789abcdef0123456789abcdef01',
  workerImage: 'docker.io/exampleorg/reviewyeti-worker:latest',
  env: {
    NODE_ENV: 'test',
  },
  cpu: 2,
  memoryMb: 2048,
  timeoutSeconds: 300,
};

describe('M3 Challenger 1 Iteration 2 Empirical Re-Challenge Suite', () => {
  // =========================================================================
  // Mission 2: Re-challenge CloudflareContainerRunner Two-Tier Termination
  // =========================================================================
  describe('2. CloudflareContainerRunner Two-Tier Termination Re-Challenge', () => {
    it('Scenario 2.1: activeInstance.terminate() succeeds, but containersBinding.terminate() throws -> terminateJob returns { terminated: true }', async () => {
      let instanceTerminatedCalled = false;
      let instanceReasonReceived = '';
      let bindingTerminatedCalled = false;
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async (opts?: { reason?: string }) => {
            instanceTerminatedCalled = true;
            instanceReasonReceived = opts?.reason || '';
          },
        }),
        terminate: async () => {
          bindingTerminatedCalled = true;
          throw new Error('RPC connection to Cloudflare Computer worker binding timed out');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      // Wait briefly for job to register in activeJobs map
      await new Promise((r) => setTimeout(r, 15));

      const termResult = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_new_commit');

      // Assertions
      assert.equal(instanceTerminatedCalled, true, 'activeInstance.terminate() must have been invoked');
      assert.equal(instanceReasonReceived, 'superseded_by_new_commit', 'Reason must be passed to activeInstance');
      assert.equal(bindingTerminatedCalled, true, 'containersBinding.terminate() was invoked');
      assert.equal(termResult.terminated, true, 'Must return { terminated: true } even when binding-level terminate throws');

      // Clean up wait promise
      waitResolve({ exitCode: 137, status: 'cancelled' });
      const jobResult = await dispatchPromise;
      assert.equal(jobResult.status, 'cancelled');
    });

    it('Scenario 2.2: activeInstance.terminate() throws, but containersBinding.terminate() succeeds -> terminateJob returns { terminated: true }', async () => {
      let instanceTerminatedCalled = false;
      let bindingTerminatedCalled = false;
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            instanceTerminatedCalled = true;
            throw new Error('Instance socket already closed');
          },
        }),
        terminate: async () => {
          bindingTerminatedCalled = true;
          return { ok: true };
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      await new Promise((r) => setTimeout(r, 15));

      const termResult = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_new_commit');

      assert.equal(instanceTerminatedCalled, true);
      assert.equal(bindingTerminatedCalled, true);
      assert.equal(termResult.terminated, true, 'Must return { terminated: true } if binding tier succeeds');

      waitResolve({ exitCode: 137, status: 'cancelled' });
      await dispatchPromise;
    });

    it('Scenario 2.3: Both activeInstance.terminate() and containersBinding.terminate() throw -> terminateJob returns { terminated: false }', async () => {
      let waitResolve: any;

      const mockBinding = {
        create: async () => ({
          wait: () => new Promise((resolve) => { waitResolve = resolve; }),
          terminate: async () => {
            throw new Error('Instance terminate crashed');
          },
        }),
        terminate: async () => {
          throw new Error('Binding terminate crashed');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const dispatchPromise = runner.dispatchJob(sampleSpec);

      await new Promise((r) => setTimeout(r, 15));

      const termResult = await runner.terminateJob(sampleSpec.jobId, 'superseded_by_new_commit');

      assert.equal(termResult.terminated, false, 'Must return { terminated: false } when both tiers fail');

      waitResolve({ exitCode: 1, status: 'failed' });
      await dispatchPromise;
    });

    it('Scenario 2.4: Untracked jobId with failing containersBinding.terminate() -> terminateJob returns { terminated: false }', async () => {
      const mockBinding = {
        terminate: async () => {
          throw new Error('Job not found in cluster');
        },
      };

      const runner = new CloudflareContainerRunner(mockBinding);
      const termResult = await runner.terminateJob('unknown_job_id');

      assert.equal(termResult.terminated, false, 'Untracked job with failing binding must return { terminated: false }');
    });
  });
});
