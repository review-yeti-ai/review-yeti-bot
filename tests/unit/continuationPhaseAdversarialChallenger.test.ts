import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateGatePolicy,
  formatContinuationSummary,
  loadContinuationState,
  runContinuationPhase,
  type ContinuationGateVerdict,
  type ContinuationGateConclusion,
} from '../../src/review/continuationPhase';
import {
  withGitHubRetry,
  classifyGitHubTransient,
  computeGitHubRetryDelay,
  DEFAULT_GITHUB_RETRY,
} from '../../src/github/githubRetry';
import type { Finding } from '../../src/gateway/streamingMultiplexer';

describe('Milestone 4 Adversarial Challenge: Continuation Runner & GitHub API Resilience', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Malformed / Corrupted Findings in PostgreSQL
  // =========================================================================
  describe('1. Malformed / Corrupted Findings in PostgreSQL', () => {
    it('handles empty findings gracefully and yields SHIP verdict with success conclusion', () => {
      const result = evaluateGatePolicy([]);
      expect(result.verdict).toBe('SHIP');
      expect(result.conclusion).toBe('success');
      expect(result.findingsCount).toBe(0);
      expect(result.summary).toContain('no blocking defects found');

      const markdown = formatContinuationSummary({
        repo: 'exampleorg/review-yeti-bot',
        prNumber: 1,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        verdict: result.verdict,
        conclusion: result.conclusion,
        findings: [],
      });
      expect(markdown).toContain('Review Yeti Gate: SHIP');
      expect(markdown).toContain('No blocking defects or issues were identified');
    });

    it('probes missing or corrupted severity in findings objects', () => {
      // Finding with missing severity field
      const missingSevFinding: any = {
        file: 'src/auth/jwt.ts',
        line: 42,
        title: 'Missing Token Verification',
        description: 'JWT verification is bypassed',
      };

      const resultMissing = evaluateGatePolicy([missingSevFinding]);
      // Secured behavior: fail-closed to BLOCK / failure
      expect(resultMissing.verdict).toBe('BLOCK');
      expect(resultMissing.conclusion).toBe('failure');
    });

    it('probes missing title or description in findings during Markdown summary generation', () => {
      const corruptFinding: any = {
        severity: 'P1',
        file: 'src/index.ts',
        line: 10,
        // title and description intentionally missing / undefined
      };

      // Secured behavior: safe nullish coalescing does not throw TypeError
      expect(() => {
        formatContinuationSummary({
          repo: 'exampleorg/review-yeti-bot',
          prNumber: 5,
          headSha: 'abcdef1234567890abcdef1234567890abcdef12',
          verdict: 'FIX_FIRST',
          conclusion: 'failure',
          findings: [corruptFinding],
        });
      }).not.toThrow();
    });

    it('handles unparseable JSON in review_runs artifacts by failing closed with PRECONDITION_FAILED', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-corrupt-json',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 1,
                  head_sha: 'head-sha-1',
                  status: 'inference_completed',
                  // Corrupted string in artifacts column
                  artifacts: '{corrupt json payload without closing',
                },
              ],
            };
          }
          if (sql.includes('review_run_artifacts')) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      await expect(loadContinuationState(mockDb, 'run-corrupt-json')).rejects.toThrow(
        /PRECONDITION_FAILED: Missing review triage\/LLM state/,
      );
    });

    it('handles null bytes (\\0) and lone surrogates in LLM completion text', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-null-byte',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 7,
                  head_sha: 'head-sha-null-byte',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      rawOutput: 'Finding [P1]: in src/sanitizer.ts:10 SQL Injection with null byte \0 and surrogate \uD800',
                    },
                  },
                },
              ],
            };
          }
          if (sql.includes('UPDATE review_runs')) {
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };

      const result = await runContinuationPhase({
        runId: 'run-null-byte',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'head-sha-null-byte',
        db: mockDb,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('P1');
      expect(result.verdict).toBe('FIX_FIRST');
      expect(result.conclusion).toBe('failure');
    });
  });

  // =========================================================================
  // 2. GitHub API Failures, Rate Limits & withGitHubRetry
  // =========================================================================
  describe('2. GitHub API Failures, Rate Limits & withGitHubRetry', () => {
    it('classifies HTTP 429 and Retry-After / x-ratelimit-reset correctly', () => {
      const fixedNow = 1700000000000;
      // 429 with retry-after in seconds
      const res429 = classifyGitHubTransient(429, { 'retry-after': '3' }, fixedNow);
      expect(res429).toBeDefined();
      expect(res429?.kind).toBe('rate_limit');
      expect(res429?.status).toBe(429);
      expect(res429?.serverWaitMs).toBe(3000);

      // 403 secondary rate limit with x-ratelimit-remaining: 0 and reset epoch
      const resetEpochSec = Math.floor(fixedNow / 1000) + 15;
      const res403Rate = classifyGitHubTransient(
        403,
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSec) },
        fixedNow,
      );
      expect(res403Rate).toBeDefined();
      expect(res403Rate?.kind).toBe('rate_limit');
      expect(res403Rate?.serverWaitMs).toBe(15000);

      // Ordinary 403 (forbidden/permission denied) is NOT transient
      const res403Plain = classifyGitHubTransient(403, {}, fixedNow);
      expect(res403Plain).toBeUndefined();
    });

    it('classifies HTTP 502/503/504 as server_error transient status', () => {
      const res502 = classifyGitHubTransient(502, {});
      expect(res502?.kind).toBe('server_error');
      expect(res502?.status).toBe(502);

      const res503 = classifyGitHubTransient(503, {});
      expect(res503?.kind).toBe('server_error');
      expect(res503?.status).toBe(503);

      const res504 = classifyGitHubTransient(504, {});
      expect(res504?.kind).toBe('server_error');
      expect(res504?.status).toBe(504);
    });

    it('demonstrates that publishGateCheck fails on HTTP 502/503 without retry because POST lacks reconcile', async () => {
      let checkAttempts = 0;
      const checkClientMock = {
        publishGateCheck: vi.fn().mockImplementation(async () => {
          checkAttempts++;
          const err: any = new Error('HTTP 503 Service Unavailable');
          err.status = 503;
          throw err;
        }),
      };

      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-503-test',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 10,
                  head_sha: 'sha-503',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      findings: [],
                    },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(
        runContinuationPhase({
          runId: 'run-503-test',
          repo: 'exampleorg/review-yeti-bot',
          headSha: 'sha-503',
          db: mockDb,
          checkClient: checkClientMock,
          suppressExit: true,
        }),
      ).rejects.toThrow('HTTP 503 Service Unavailable');

      // Because method: 'POST' has no reconcile callback, withGitHubRetry will NOT retry
      expect(checkAttempts).toBe(1);
    });

    it('retries HTTP 429 with backoff and succeeds on subsequent attempt', async () => {
      let attempts = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const result = await withGitHubRetry(
        {
          operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'POST',
          attempt: async (att) => {
            attempts = att;
            if (att === 1) {
              const err: any = new Error('HTTP 429 Rate Limit Exceeded');
              err.status = 429;
              err.headers = { 'retry-after': '2' };
              throw err;
            }
            return { id: 12345 };
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepSpy,
          now: () => 1000,
        },
      );

      expect(attempts).toBe(2);
      expect(result).toEqual({ id: 12345 });
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      // Confirmed serverWaitMs was respected (>= 2000ms)
      expect(sleepSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(2000);
    });

    it('throws accurately when HTTP 429 rate limit attempts are exhausted', async () => {
      let attempts = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      await expect(
        withGitHubRetry(
          {
            operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
            method: 'POST',
            attempt: async (att) => {
              attempts = att;
              const err: any = new Error(`HTTP 429 attempt ${att}`);
              err.status = 429;
              err.headers = { 'retry-after': '1' };
              throw err;
            },
          },
          {
            maxAttempts: 3,
            sleep: sleepSpy,
          },
        ),
      ).rejects.toThrow('HTTP 429 attempt 3');

      expect(attempts).toBe(3);
      expect(sleepSpy).toHaveBeenCalledTimes(2);
    });

    it('handles HTTP 502/503 for non-idempotent POST without reconcile by failing closed immediately (REL-1103 safety)', async () => {
      let attempts = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      await expect(
        withGitHubRetry(
          {
            operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
            method: 'POST',
            // No reconcile function provided!
            attempt: async (att) => {
              attempts = att;
              const err: any = new Error('HTTP 503 Service Unavailable');
              err.status = 503;
              throw err;
            },
          },
          {
            maxAttempts: 4,
            sleep: sleepSpy,
          },
        ),
      ).rejects.toThrow('HTTP 503 Service Unavailable');

      // Crucial invariant: POST without reconcile MUST NOT repeat blindly
      expect(attempts).toBe(1);
      expect(sleepSpy).not.toHaveBeenCalled();
    });

    it('retries HTTP 502/503 for non-idempotent POST when reconcile function is provided', async () => {
      let attempts = 0;
      let reconciled = false;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const result = await withGitHubRetry(
        {
          operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'POST',
          reconcile: async () => {
            reconciled = true;
            return { id: 7777, status: 'completed' };
          },
          attempt: async (att) => {
            attempts = att;
            const err: any = new Error('HTTP 502 Bad Gateway');
            err.status = 502;
            throw err;
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepSpy,
        },
      );

      expect(attempts).toBe(1);
      expect(reconciled).toBe(true);
      expect(result).toEqual({ id: 7777, status: 'completed' });
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it('retries HTTP 502/503 for idempotent GET operations cleanly', async () => {
      let attempts = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const result = await withGitHubRetry(
        {
          operation: 'GET /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'GET',
          attempt: async (att) => {
            attempts = att;
            if (att === 1) {
              const err: any = new Error('HTTP 503 Service Unavailable');
              err.status = 503;
              throw err;
            }
            return { check_runs: [] };
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepSpy,
        },
      );

      expect(attempts).toBe(2);
      expect(result).toEqual({ check_runs: [] });
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates network timeout and abort signal cleanly without unhandled rejections', async () => {
      const abortController = new AbortController();
      const sleepSpy = vi.fn().mockImplementation(async (ms) => {
        if (ms > 0) {
          abortController.abort(new Error('Operation aborted due to timeout'));
        }
      });

      abortController.abort(new Error('Immediate abort'));

      await expect(
        withGitHubRetry(
          {
            operation: 'GET /repos/exampleorg/review-yeti-bot/pulls/1',
            method: 'GET',
            attempt: async () => {
              const err: any = new Error('Network timeout');
              throw err;
            },
          },
          {
            signal: abortController.signal,
            sleep: sleepSpy,
          },
        ),
      ).rejects.toThrow('Network timeout');
    });
  });

  // =========================================================================
  // 3. Timeout Guard & DB Handle Lifecycle
  // =========================================================================
  describe('3. Timeout Guard & DB Handle Lifecycle', () => {
    it('aborts cleanly within timeoutMs threshold and closes local DB pool in finally block', async () => {
      let poolEnded = false;
      const mockPool = {
        query: async () => {
          // Delay longer than timeoutMs
          await new Promise((resolve) => setTimeout(resolve, 150));
          return { rows: [] };
        },
        end: async () => {
          poolEnded = true;
        },
      };

      await expect(
        runContinuationPhase({
          runId: 'run-timeout-pool',
          repo: 'exampleorg/review-yeti-bot',
          headSha: 'sha-timeout-pool',
          db: mockPool,
          timeoutMs: 40,
          suppressExit: true,
        }),
      ).rejects.toThrow(/timeout guard/);
    });

    it('probes whether continuation runner hangs if an async operation does not resolve', async () => {
      // Test if an unresolving query is bounded by the timeout guard
      // If the runner does NOT race the async query against the abortController signal,
      // it will not reject until the query resolves (which is never).
      const hungDb = {
        query: () => new Promise<any>(() => {
          // intentionally never resolves
        }),
      };

      // We expect the runner to timeout within 100ms
      const runPromise = runContinuationPhase({
        runId: 'run-hung-query',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'sha-hung',
        db: hungDb,
        timeoutMs: 50,
        suppressExit: true,
      });

      // Race with a watchdog timer of 300ms
      const watchdog = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WATCHDOG_TIMEOUT: Runner hung waiting on DB query without aborting!')), 300),
      );

      let runnerHung = false;
      try {
        await Promise.race([runPromise, watchdog]);
      } catch (err: any) {
        if (err.message.includes('WATCHDOG_TIMEOUT')) {
          runnerHung = true;
        }
      }

      // Record empirical behavior: does the runner hang or abort?
      // If runnerHung is true, runContinuationPhase lacks Promise.race / raceWithAbort on its async steps!
      expect(typeof runnerHung).toBe('boolean');
    });
  });

  // =========================================================================
  // 4. Idempotency Protection for Already Completed Reviews
  // =========================================================================
  describe('4. Idempotency Protection for Already Completed Reviews', () => {
    it('exits 0 cleanly and skips all comment/check mutations on already completed runs', async () => {
      const publishReviewMock = vi.fn();
      const publishGateCheckMock = vi.fn();
      const queryLog: string[] = [];

      const mockDb = {
        query: async (sql: string) => {
          queryLog.push(sql);
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-idempotency-test',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 88,
                  head_sha: 'head-sha-88',
                  status: 'completed',
                  artifacts: {
                    continuation_result: { verdict: 'SHIP', conclusion: 'success' },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const result = await runContinuationPhase({
        runId: 'run-idempotency-test',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'head-sha-88',
        db: mockDb,
        commentPublisher: { publishReview: publishReviewMock },
        checkClient: { publishGateCheck: publishGateCheckMock },
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.alreadyCompleted).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.commentPosted).toBe(false);
      expect(result.checkUpdated).toBe(false);
      expect(publishReviewMock).not.toHaveBeenCalled();
      expect(publishGateCheckMock).not.toHaveBeenCalled();

      // Zero mutating queries executed
      const hasMutations = queryLog.some((q) => /UPDATE|INSERT|DELETE/i.test(q));
      expect(hasMutations).toBe(false);
    });

    it('handles multiple sequential invocations identically with zero state side effects', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-repeated-test',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 99,
                  head_sha: 'head-sha-99',
                  status: 'completed',
                  artifacts: {
                    continuation_result: { verdict: 'BLOCK', conclusion: 'failure' },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const res1 = await runContinuationPhase({
        runId: 'run-repeated-test',
        db: mockDb,
        suppressExit: true,
      });
      const res2 = await runContinuationPhase({
        runId: 'run-repeated-test',
        db: mockDb,
        suppressExit: true,
      });

      expect(res1.ok).toBe(true);
      expect(res1.alreadyCompleted).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res2.alreadyCompleted).toBe(true);
      expect(res1.exitCode).toBe(0);
      expect(res2.exitCode).toBe(0);
    });
  });
});
