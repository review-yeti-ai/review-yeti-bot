import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';
import { CloudflareContainerRunner } from '../src/runners/containerRunner.js';
import type { ContainerJobSpec } from '../src/runners/containerRunner.js';

const sampleSpec: ContainerJobSpec = {
  jobId: 'job_challenger_iter2_001',
  runId: 'run_challenger_iter2_001',
  owner: 'calltelemetry',
  repo: 'reviewyeti',
  prNumber: 42,
  headSha: '0123456789abcdef0123456789abcdef01234567',
  baseSha: 'abcdef0123456789abcdef0123456789abcdef01',
  workerImage: 'docker.io/calltelemetry/reviewyeti-worker:latest',
  env: {
    NODE_ENV: 'test',
  },
  cpu: 2,
  memoryMb: 2048,
  timeoutSeconds: 300,
};

describe('M3 Challenger 1 Iteration 2 Empirical Re-Challenge Suite', () => {
  // =========================================================================
  // Mission 1: Re-challenge DigitalOceanAgentRunner Status Mapping
  // =========================================================================
  describe('1. DigitalOceanAgentRunner Status Mapping Re-Challenge', () => {
    it('Scenario 1.1: Payload with status: "failed" and omitted exit_code -> status === "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          status: 'failed',
          error: 'Firecracker runtime initialization failed before entrypoint',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed', 'Must map status: "failed" with omitted exit_code to status: "failed"');
      assert.equal(res.exitCode, 0, 'Exit code defaults to 0 when omitted by DO API');
      assert.equal(res.error, 'Firecracker runtime initialization failed before entrypoint');
    });

    it('Scenario 1.2: Payload with status: "error" and exit_code: 0 -> status === "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          status: 'error',
          exit_code: 0,
          error: 'Control plane provisioning error occurred in agent cluster',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed', 'Must map status: "error" with exit_code: 0 to status: "failed"');
      assert.equal(res.exitCode, 0);
      assert.equal(res.error, 'Control plane provisioning error occurred in agent cluster');
    });

    it('Scenario 1.3: Payload with missing status and exit_code: 1 -> status === "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          // status property completely omitted
          exit_code: 1,
          error: 'Worker process terminated with uncaught exception',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed', 'Must map missing status with exit_code: 1 to status: "failed"');
      assert.equal(res.exitCode, 1);
      assert.equal(res.error, 'Worker process terminated with uncaught exception');
    });

    it('Scenario 1.4: Payload with status: "succeeded" and exit_code: 0 -> status === "succeeded"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          status: 'succeeded',
          exit_code: 0,
          receipt: {
            version: 'ReviewYetiReceiptOnly.v1',
            status: 'succeeded',
            runId: sampleSpec.runId,
            findings: [],
          },
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'succeeded', 'Must map status: "succeeded" with exit_code: 0 to status: "succeeded"');
      assert.equal(res.exitCode, 0);
      assert.ok(res.receipt, 'Receipt must be passed through');
      assert.equal(res.receipt.status, 'succeeded');
    });

    // Additional boundary stress test cases
    it('Scenario 1.5 (Adversarial): status: "succeeded" but exit_code: 2 -> status === "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          status: 'succeeded',
          exit_code: 2,
          error: 'Process crashed after writing receipt',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed', 'Non-zero exit code must override false success status');
      assert.equal(res.exitCode, 2);
    });

    it('Scenario 1.6 (Adversarial): Unknown status "foo_bar" with exit_code: 0 -> status === "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_challenger_iter2_001',
          status: 'foo_bar',
          exit_code: 0,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_valid_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed', 'Unrecognized status must fall back to failed');
      assert.equal(res.exitCode, 0);
    });
  });

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
