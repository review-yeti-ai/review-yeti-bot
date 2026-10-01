import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';
import type { ContainerJobSpec } from '../src/runners/containerRunner.js';

describe('DigitalOceanAgentRunner Integration & Unit Suite', () => {
  const sampleSpec: ContainerJobSpec = {
    jobId: 'job_do_123',
    runId: 'run_123',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 42,
    headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    workerImage: 'registry.digitalocean.com/calltelemetry/review-yeti-worker:latest',
    env: { GITHUB_TOKEN: 'token_abc', RUN_ID: 'run_123' },
  };

  describe('Happy Path Dispatch', () => {
    it('dispatches job successfully to DO Managed Agent endpoint', async () => {
      let capturedUrl = '';
      let capturedBody: any;

      const mockFetch = async (url: any, init: any) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            session_id: 'job_do_123',
            status: 'succeeded',
            exit_code: 0,
            receipt: { version: 'ReviewYetiReceiptOnly.v1', status: 'succeeded' },
          }),
        } as any;
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        agentId: 'review-yeti-swarm',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'succeeded');
      assert.equal(result.exitCode, 0);
      assert.ok(capturedUrl.includes('/v2/genai/agents/review-yeti-swarm/sessions'));
      assert.equal(capturedBody.session_id, 'job_do_123');
      assert.equal(capturedBody.resources.vcpus, 2);
    });

    it('captures output_log from session result', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'succeeded',
          exit_code: 0,
          output_log: 'DO MicroVM execution completed cleanly in 14.2s',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'succeeded');
      assert.equal(result.outputLog, 'DO MicroVM execution completed cleanly in 14.2s');
    });
  });

  describe('Token Validation & Configuration', () => {
    it('fails fast when API token is empty or missing', async () => {
      const runner = new DigitalOceanAgentRunner({ apiToken: '' });
      const result = await runner.dispatchJob(sampleSpec);

      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('API token is required'));
    });

    it('normalizes custom baseUrl with multiple trailing slashes and port numbers', async () => {
      let capturedUrl = '';
      const mockFetch = async (url: any) => {
        capturedUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ session_id: 'job_do_123', status: 'succeeded', exit_code: 0 }),
        } as any;
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        baseUrl: 'https://custom-do-gateway.internal:8443///',
        fetchImpl: mockFetch as any,
      });

      await runner.dispatchJob(sampleSpec);
      assert.ok(capturedUrl.startsWith('https://custom-do-gateway.internal:8443/v2/genai/agents/'));
      assert.ok(!capturedUrl.includes('///'));
    });
  });

  describe('Error Handling & Network Drops', () => {
    it('handles network drop / socket disconnect during dispatch', async () => {
      const mockFetch = async () => {
        throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:443');
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('ECONNREFUSED'));
    });

    it('handles non-200 HTTP response status with error body extraction', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 429,
        text: async () => 'Resource rate limit exceeded (max 5 active sessions)',
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('429'));
      assert.ok(result.error?.includes('Resource rate limit exceeded'));
    });

    it('handles invalid non-JSON response body from DO endpoint', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'failed');
      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes('Failed to parse DO Managed Agent response JSON'));
    });
  });

  describe('Timeout & Cancellation Status Mapping', () => {
    it('correctly maps session status timed_out and exit code 124 to timed_out', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'timed_out',
          exit_code: 124,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
    });

    it('catches TimeoutError and maps to status timed_out with exitCode 124', async () => {
      const mockFetch = async () => {
        const err: any = new Error('Session dispatch timed out after 1500s');
        err.name = 'TimeoutError';
        throw err;
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'timed_out');
      assert.equal(result.exitCode, 124);
      assert.ok(result.error?.includes('timed out'));
    });

    it('correctly maps session status cancelled and exit code 137 to cancelled', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'cancelled',
          exit_code: 137,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 137);
    });

    it('catches AbortError and maps to status cancelled with exitCode 137', async () => {
      const mockFetch = async () => {
        const err: any = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const result = await runner.dispatchJob(sampleSpec);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.exitCode, 137);
      assert.ok(result.error?.includes('aborted'));
    });
  });

  describe('Session Termination & Cancellation (F24 & B27)', () => {
    it('terminates DO Managed Agent session on cancellation via HTTP DELETE', async () => {
      let capturedMethod = '';
      let capturedReason = '';

      const mockFetch = async (url: any, init: any) => {
        capturedMethod = init.method;
        capturedReason = init.headers['X-Cancel-Reason'];
        return { ok: true, status: 200 } as any;
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        agentId: 'review-yeti-swarm',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.terminateJob('job_do_123', 'superseded');
      assert.equal(res.terminated, true);
      assert.equal(capturedMethod, 'DELETE');
      assert.equal(capturedReason, 'superseded');
    });

    it('treats HTTP 404 on session delete as successful termination (B27)', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 404,
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.terminateJob('job_nonexistent');
      assert.equal(res.terminated, true);
    });

    it('returns { terminated: false } when terminateJob network request throws', async () => {
      const mockFetch = async () => {
        throw new Error('Network failure during DELETE');
      };

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.terminateJob('job_do_123');
      assert.equal(res.terminated, false);
    });
  });

  describe('Status Mapping & Failure Reporting Edge Cases (Fix for CRITICAL defect)', () => {
    it('maps session status "failed" with omitted exit_code to status "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'failed',
          error: 'MicroVM initialization failed before process launch',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 0);
      assert.equal(res.error, 'MicroVM initialization failed before process launch');
    });

    it('maps session status "failed" with exit_code: 0 to status "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'failed',
          exit_code: 0,
          error: 'Host OOM during container initialization',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 0);
      assert.equal(res.error, 'Host OOM during container initialization');
    });

    it('maps session status "error" with omitted exit_code to status "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'error',
          error: 'Agent image pull quota exceeded',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 0);
      assert.equal(res.error, 'Agent image pull quota exceeded');
    });

    it('maps session status "error" with exit_code: 0 to status "failed"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'error',
          exit_code: 0,
          error: 'Control plane RPC error',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 0);
      assert.equal(res.error, 'Control plane RPC error');
    });

    it('maps non-zero exit_code (e.g. 1) to status "failed" even if status string is omitted', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          exit_code: 1,
          error: 'Process crashed with uncaught exception',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 1);
    });

    it('maps non-zero exit_code (e.g. 1) to status "failed" even if session status claims "succeeded"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'succeeded',
          exit_code: 1,
          error: 'Worker exited with failure code 1',
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 1);
    });

    it('maps status "succeeded" with exit_code: 0 to status "succeeded"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'succeeded',
          exit_code: 0,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'succeeded');
      assert.equal(res.exitCode, 0);
    });

    it('maps omitted status with exit_code: 0 to status "succeeded"', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          exit_code: 0,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'succeeded');
      assert.equal(res.exitCode, 0);
    });

    it('maps unknown status string with exit_code: 0 to status "failed" as safe fallback', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          session_id: 'job_do_123',
          status: 'unrecognized_state',
          exit_code: 0,
        }),
      } as any);

      const runner = new DigitalOceanAgentRunner({
        apiToken: 'dop_v1_mock_token',
        fetchImpl: mockFetch as any,
      });

      const res = await runner.dispatchJob(sampleSpec);
      assert.equal(res.status, 'failed');
      assert.equal(res.exitCode, 0);
    });
  });
});
