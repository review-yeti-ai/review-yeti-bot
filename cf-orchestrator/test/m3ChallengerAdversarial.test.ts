import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CloudflareContainerRunner,
  type ContainerJobSpec,
} from '../src/runners/containerRunner.js';
import { DigitalOceanAgentRunner } from '../src/runners/digitalOceanAgentRunner.js';

describe('M3 Challenger Adversarial Stress Suite', () => {
  const baseSpec: ContainerJobSpec = {
    jobId: 'job_adv_001',
    runId: 'run_adv_001',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 99,
    headSha: '1111222233334444555566667777888899990000',
    baseSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
    workerImage: 'registry.calltelemetry.com/review-yeti/worker:staging',
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

  // =========================================================================
  // Section 2: DigitalOceanAgentRunner Adversarial Challenges
  // =========================================================================
  describe('DigitalOceanAgentRunner Adversarial Challenges', () => {
    describe('2.1 Fast-Fail on Missing / Whitespace apiToken', () => {
      it('fails fast on undefined apiToken', async () => {
        const runner = new DigitalOceanAgentRunner({});
        const res = await runner.dispatchJob(baseSpec);

        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.equal(res.durationMs, 0);
        assert.ok(res.error?.includes('API token is required'));
      });

      it('fails fast on empty string apiToken', async () => {
        const runner = new DigitalOceanAgentRunner({ apiToken: '' });
        const res = await runner.dispatchJob(baseSpec);

        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.equal(res.durationMs, 0);
        assert.ok(res.error?.includes('API token is required'));
      });

      it('fails fast on whitespace-only apiToken (spaces, tabs, newlines)', async () => {
        const runner = new DigitalOceanAgentRunner({ apiToken: '   \t  \n  ' });
        const res = await runner.dispatchJob(baseSpec);

        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.equal(res.durationMs, 0);
        assert.ok(res.error?.includes('API token is required'));
      });
    });

    describe('2.2 HTTP 404 Session Delete Treated as Success (B27)', () => {
      it('returns { terminated: true } when DELETE responds with HTTP 404', async () => {
        let capturedMethod = '';
        let capturedUrl = '';

        const mockFetch = async (url: any, init: any) => {
          capturedUrl = String(url);
          capturedMethod = init.method;
          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
          } as any;
        };

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock_secret',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.terminateJob('job_already_expired');
        assert.equal(res.terminated, true);
        assert.equal(capturedMethod, 'DELETE');
        assert.ok(capturedUrl.includes('/sessions/job_already_expired'));
      });

      it('returns { terminated: true } when DELETE responds with HTTP 200 or 204', async () => {
        const mockFetch = async () => ({
          ok: true,
          status: 204,
          statusText: 'No Content',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock_secret',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.terminateJob('job_active');
        assert.equal(res.terminated, true);
      });

      it('returns { terminated: false } when DELETE responds with HTTP 500', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock_secret',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.terminateJob('job_error');
        assert.equal(res.terminated, false);
      });

      it('returns { terminated: false } when DELETE network request throws', async () => {
        const mockFetch = async () => {
          throw new TypeError('fetch failed: connect ETIMEDOUT');
        };

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock_secret',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.terminateJob('job_timeout');
        assert.equal(res.terminated, false);
      });
    });

    describe('2.3 Non-200 Responses Handled Gracefully Without Syntax Errors', () => {
      it('handles HTTP 401 Unauthorized cleanly', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
          text: async () => '{"error": "Invalid bearer token"}',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_bad_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('401'));
        assert.ok(res.error?.includes('Invalid bearer token'));
      });

      it('handles HTTP 403 Forbidden cleanly', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => '{"error": "Insufficient scope for genai:agents:write"}',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('403'));
      });

      it('handles HTTP 429 Rate Limit Exceeded cleanly', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Rate limit exceeded: 60 requests per minute',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('429'));
        assert.ok(res.error?.includes('Rate limit exceeded'));
      });

      it('handles HTTP 500 Internal Server Error cleanly', async () => {
        const mockFetch = async () => ({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: async () => 'Database connection pool exhausted in DO control plane',
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('500'));
      });

      it('handles HTTP 502 Bad Gateway with raw HTML error page without SyntaxError', async () => {
        const htmlPayload = `<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`;

        const mockFetch = async () => ({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          text: async () => htmlPayload,
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('502'));
        assert.ok(res.error?.includes('Bad Gateway'));
      });

      it('handles HTTP 200 OK with non-JSON body without crashing process', async () => {
        const mockFetch = async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0');
          },
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_token',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.ok(res.error?.includes('Failed to parse DO Managed Agent response JSON'));
      });
    });

    describe('2.4 Verification of X-Cancel-Reason Header and DELETE Parameters', () => {
      it('sends default X-Cancel-Reason: superseded_or_closed when reason is omitted', async () => {
        let capturedHeaders: any;
        let capturedMethod = '';

        const mockFetch = async (_url: any, init: any) => {
          capturedHeaders = init.headers;
          capturedMethod = init.method;
          return { ok: true, status: 200 } as any;
        };

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_my_token',
          fetchImpl: mockFetch as any,
        });

        await runner.terminateJob('job_cancel_test');
        assert.equal(capturedMethod, 'DELETE');
        assert.equal(capturedHeaders['X-Cancel-Reason'], 'superseded_or_closed');
        assert.equal(capturedHeaders['Authorization'], 'Bearer dop_v1_my_token');
      });

      it('sends custom X-Cancel-Reason when reason is provided', async () => {
        let capturedHeaders: any;

        const mockFetch = async (_url: any, init: any) => {
          capturedHeaders = init.headers;
          return { ok: true, status: 200 } as any;
        };

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_my_token',
          fetchImpl: mockFetch as any,
        });

        await runner.terminateJob('job_cancel_test', 'pr_converted_to_draft_by_reviewer');
        assert.equal(capturedHeaders['X-Cancel-Reason'], 'pr_converted_to_draft_by_reviewer');
      });

      it('properly encodes special characters in agentId and jobId', async () => {
        let capturedUrl = '';

        const mockFetch = async (url: any) => {
          capturedUrl = String(url);
          return { ok: true, status: 200 } as any;
        };

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_my_token',
          agentId: 'swarm/prod:special',
          fetchImpl: mockFetch as any,
        });

        await runner.terminateJob('job#123?test=1&x=2');
        assert.ok(capturedUrl.includes('/v2/genai/agents/swarm%2Fprod%3Aspecial/sessions/job%23123%3Ftest%3D1%26x%3D2'));
      });
    });

    describe('2.5 Critical Adversarial Probe: Session Outcome Mapping', () => {
      it('correctly maps DO session status: "failed" when exit_code is non-zero (exit_code: 1)', async () => {
        const mockFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            session_id: 'job_adv_001',
            status: 'failed',
            exit_code: 1,
            error: 'Review process exited with code 1',
          }),
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 1);
        assert.equal(res.error, 'Review process exited with code 1');
      });

      it('correctly maps DO session with status: "failed" and omitted exit_code to status "failed"', async () => {
        const mockFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            session_id: 'job_adv_001',
            status: 'failed',
            error: 'MicroVM failed to initialize runtime',
          }),
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 0);
        assert.equal(res.error, 'MicroVM failed to initialize runtime');
      });

      it('correctly maps DO session with status: "failed" and exit_code: 0 to status "failed"', async () => {
        const mockFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            session_id: 'job_adv_001',
            status: 'failed',
            exit_code: 0,
            error: 'OOM before process launch',
          }),
        } as any);

        const runner = new DigitalOceanAgentRunner({
          apiToken: 'dop_v1_mock',
          fetchImpl: mockFetch as any,
        });

        const res = await runner.dispatchJob(baseSpec);
        assert.equal(res.status, 'failed');
        assert.equal(res.exitCode, 0);
      });
    });
  });
});
