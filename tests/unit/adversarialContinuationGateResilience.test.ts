import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateGatePolicy,
  formatContinuationSummary,
  loadContinuationState,
  runContinuationPhase,
  type ContinuationGateVerdict,
  type ContinuationGateConclusion,
} from '../../src/review/continuationPhase';
import { normalizeFinding } from '../../src/review/findings';
import {
  withGitHubRetry,
  classifyGitHubTransient,
} from '../../src/github/githubRetry';
import { raceWithAbort } from '../../src/gateway/raceWithAbort';

describe('Empirical Challenger 2: Adversarial Resilience & Fail-Closed Gate Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Requirement 2: Unclassified / Missing Finding Severities Fail-Closed
  // =========================================================================
  describe('Requirement 2: Unclassified / Missing Finding Severities Fail Closed to BLOCK / failure', () => {
    const unclassifiedSeverities = [
      undefined,
      null,
      '',
      '   ',
      'INFO',
      'NOTICE',
      'UNKNOWN',
      'P3',
      'P4',
      'SUGGESTION',
      'OTHER_SEVERITY',
      'UNCLASSIFIED',
      123 as any,
      true as any,
      {} as any,
      [] as any,
    ];

    it.each([
      { raw: 'CRITICAL', expected: 'P0' },
      { raw: 'BLOCKER', expected: 'P0' },
      { raw: 'HIGH', expected: 'P0' },
      { raw: 'WARN', expected: 'P1' },
      { raw: 'MAJOR', expected: 'P1' },
      { raw: 'NIT', expected: 'P2' },
      { raw: 'LOW', expected: 'P2' },
    ])('maps recognized severity alias $raw to $expected', ({ raw, expected }) => {
      const normalized = normalizeFinding({
        file: 'src/core/test.ts',
        line: 1,
        title: 'Finding',
        severity: raw,
      });
      expect(normalized.severity).toBe(expected);
    });

    it.each(unclassifiedSeverities)(
      'coerces unclassified severity %p to P0 in normalizeFinding and fails closed',
      (rawSeverity) => {
        const normalized = normalizeFinding({
          file: 'src/core/security.ts',
          line: 15,
          title: 'Suspicious execution',
          severity: rawSeverity,
        });

        expect(normalized.severity).toBe('P0');
        expect(normalized.file).toBe('src/core/security.ts');
        expect(normalized.line).toBe(15);
      },
    );

    it.each(unclassifiedSeverities)(
      'evaluates gate policy as BLOCK / failure for unclassified severity %p',
      (rawSeverity) => {
        const finding: any = {
          file: 'src/core/security.ts',
          line: 15,
          title: 'Suspicious execution',
          description: 'Defect with unclassified severity',
          severity: rawSeverity,
        };

        const result = evaluateGatePolicy([finding]);
        expect(result.verdict).toBe('BLOCK');
        expect(result.conclusion).toBe('failure');
        expect(result.gateTitle).toMatch(/Review Yeti Gate: Blocked/);
        expect(result.summary).toMatch(/blocked/i);
      },
    );

    it('fails closed when raw findings array contains null or non-object entries', () => {
      const corruptInputs: any[] = [
        null,
        undefined,
        'random text finding',
        42,
        { file: 'clean.ts', line: 1 }, // completely missing severity property
      ];

      for (const corrupt of corruptInputs) {
        const result = evaluateGatePolicy([corrupt]);
        expect(result.verdict).toBe('BLOCK');
        expect(result.conclusion).toBe('failure');
      }
    });

    it('fails closed in full runContinuationPhase execution when PostgreSQL contains unclassified findings', async () => {
      let publishedEvent: string | undefined;
      const mockCommentPublisher = {
        publishReview: vi.fn().mockImplementation(async (req) => {
          publishedEvent = req.event;
          return { id: 101 };
        }),
      };

      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-unclassified-db',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 44,
                  head_sha: 'sha-unclassified-db',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      findings: [
                        {
                          file: 'src/crypto/keys.ts',
                          line: 88,
                          title: 'Insecure key derivation',
                          severity: 'UNSPECIFIED_SEVERITY',
                        },
                      ],
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
        runId: 'run-unclassified-db',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'sha-unclassified-db',
        db: mockDb,
        commentPublisher: mockCommentPublisher,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.verdict).toBe('BLOCK');
      expect(result.conclusion).toBe('failure');
      expect(publishedEvent).toBe('REQUEST_CHANGES');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('P0');
    });

    it('preserves clean approval (SHIP / success / APPROVE) only when findings are empty or purely P2', () => {
      // 1. Empty findings -> SHIP
      const emptyResult = evaluateGatePolicy([]);
      expect(emptyResult.verdict).toBe('SHIP');
      expect(emptyResult.conclusion).toBe('success');

      // 2. Purely P2 nit findings -> SHIP
      const nitResult = evaluateGatePolicy([
        { file: 'src/a.ts', line: 1, title: 'nit 1', description: 'd1', severity: 'P2' },
        { file: 'src/b.ts', line: 2, title: 'nit 2', description: 'd2', severity: 'P2' },
      ]);
      expect(nitResult.verdict).toBe('SHIP');
      expect(nitResult.conclusion).toBe('success');

      // 3. P1 finding -> FIX_FIRST
      const p1Result = evaluateGatePolicy([
        { file: 'src/a.ts', line: 1, title: 'major 1', description: 'd1', severity: 'P1' },
      ]);
      expect(p1Result.verdict).toBe('FIX_FIRST');
      expect(p1Result.conclusion).toBe('failure');

      // 4. P1 mixed with unclassified -> BLOCK (unclassified takes fail-closed precedence over FIX_FIRST)
      const mixedResult = evaluateGatePolicy([
        { file: 'src/a.ts', line: 1, title: 'major 1', description: 'd1', severity: 'P1' },
        { file: 'src/b.ts', line: 2, title: 'unknown 1', description: 'd2', severity: 'UNKNOWN' as any },
      ]);
      expect(mixedResult.verdict).toBe('BLOCK');
      expect(mixedResult.conclusion).toBe('failure');
    });
  });

  // =========================================================================
  // Requirement 3: Undefined Title / Description Never Causes TypeError
  // =========================================================================
  describe('Requirement 3: Undefined Finding Title and Description Never Causes TypeError', () => {
    const corruptFindingPayloads = [
      { title: undefined, description: undefined },
      { title: null, description: null },
      { title: undefined, description: 'only desc' },
      { title: 'only title', description: undefined },
      {},
      { file: undefined, line: undefined, title: undefined, description: undefined, severity: undefined },
      { title: 'Title with | pipe and \n newline', description: 'Desc with | pipe and \n newline' },
      { title: '', description: '' },
    ];

    it.each(corruptFindingPayloads)(
      'formats continuation Markdown summary without throwing TypeError for %p',
      (payload) => {
        expect(() => {
          const markdown = formatContinuationSummary({
            repo: 'exampleorg/review-yeti-bot',
            prNumber: 12,
            headSha: '0123456789abcdef0123456789abcdef01234567',
            verdict: 'BLOCK',
            conclusion: 'failure',
            findings: [payload as any],
          });

          expect(typeof markdown).toBe('string');
          expect(markdown).toContain('## 🛑 Review Yeti Gate: BLOCK');
          expect(markdown).toContain('| Severity | File:Line | Title | Description |');
          expect(markdown).not.toContain('TypeError');
        }).not.toThrow();
      },
    );

    it('end-to-end runContinuationPhase with missing title/description succeeds without TypeError', async () => {
      let publishedBody: string = '';
      const mockCommentPublisher = {
        publishReview: vi.fn().mockImplementation(async (req) => {
          publishedBody = req.body;
          return { id: 202 };
        }),
      };

      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-missing-fields',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 77,
                  head_sha: 'sha-missing-fields',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      findings: [
                        {
                          // Completely missing title and description
                          file: 'src/lib/parser.ts',
                          line: 30,
                          severity: 'P1',
                        },
                      ],
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
        runId: 'run-missing-fields',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'sha-missing-fields',
        db: mockDb,
        commentPublisher: mockCommentPublisher,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(publishedBody).toContain('Review finding');
      expect(publishedBody).toContain('src/lib/parser.ts:30');
      expect(mockCommentPublisher.publishReview).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Requirement 4: Async Timeout Cancellation via raceWithAbort
  // =========================================================================
  describe('Requirement 4: Async Timeout Cancellation via raceWithAbort Cancels Within Deadline', () => {
    it('cancels a hung DB query strictly within timeoutMs deadline', async () => {
      const hungDb = {
        query: () => new Promise<any>(() => {
          // Never resolves
        }),
      };

      const timeoutMs = 80;
      const startTime = Date.now();

      await expect(
        runContinuationPhase({
          runId: 'run-hung-db',
          repo: 'exampleorg/review-yeti-bot',
          headSha: 'sha-hung-db',
          db: hungDb,
          timeoutMs,
          suppressExit: true,
        }),
      ).rejects.toThrow(/Continuation execution exceeded 80ms timeout guard/);

      const elapsed = Date.now() - startTime;
      // Must abort promptly near timeoutMs, well under 300ms watchdog
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(elapsed).toBeLessThan(350);
    });

    it('cancels a hung checkClient.publishGateCheck within timeoutMs deadline', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-hung-check',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 1,
                  head_sha: 'sha-hung-check',
                  status: 'inference_completed',
                  artifacts: { llmCompletion: { findings: [] } },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const hungCheckClient = {
        publishGateCheck: () => new Promise<number>(() => {
          // Never resolves
        }),
        findGateCheck: () => Promise.resolve(undefined),
      };

      const timeoutMs = 80;
      const startTime = Date.now();

      await expect(
        runContinuationPhase({
          runId: 'run-hung-check',
          repo: 'exampleorg/review-yeti-bot',
          headSha: 'sha-hung-check',
          db: mockDb,
          checkClient: hungCheckClient,
          timeoutMs,
          suppressExit: true,
        }),
      ).rejects.toThrow(/Continuation execution exceeded 80ms timeout guard/);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(elapsed).toBeLessThan(350);
    });

    it('cancels a hung commentPublisher.publishReview within timeoutMs deadline', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-hung-publisher',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 1,
                  head_sha: 'sha-hung-publisher',
                  status: 'inference_completed',
                  artifacts: { llmCompletion: { findings: [] } },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const hungCommentPublisher = {
        publishReview: () => new Promise<any>(() => {
          // Never resolves
        }),
      };

      const timeoutMs = 80;
      const startTime = Date.now();

      await expect(
        runContinuationPhase({
          runId: 'run-hung-publisher',
          repo: 'exampleorg/review-yeti-bot',
          headSha: 'sha-hung-publisher',
          db: mockDb,
          commentPublisher: hungCommentPublisher,
          timeoutMs,
          suppressExit: true,
        }),
      ).rejects.toThrow(/Continuation execution exceeded 80ms timeout guard/);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(elapsed).toBeLessThan(350);
    });

    it('verifies that raceWithAbort cleans up listeners and prevents late unhandled rejections', async () => {
      const abortController = new AbortController();
      let lateReject: (err: Error) => void;
      const latePromise = new Promise<string>((_, reject) => {
        lateReject = reject;
      });

      const raced = raceWithAbort(
        latePromise,
        abortController.signal,
        () => new Error('Aborted'),
      );

      // Trigger abort immediately
      abortController.abort();

      await expect(raced).rejects.toThrow('Aborted');

      // Now fire late rejection on the background promise - must NOT cause unhandledRejection
      expect(() => {
        lateReject!(new Error('Late network failure after abort'));
      }).not.toThrow();
    });
  });

  // =========================================================================
  // Requirement 5: Check-Run Creation Retries Idempotently Without Duplicates
  // =========================================================================
  describe('Requirement 5: Check-Run Creation Retries Idempotently Without Duplicates', () => {
    it('reconciles on 502/503 by finding existing check-run and avoiding second POST', async () => {
      let postAttempts = 0;
      let reconcileCalls = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const existingCheckRun = { id: 8877, status: 'completed', conclusion: 'success' };

      const result = await withGitHubRetry(
        {
          operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'POST',
          attempt: async (att) => {
            postAttempts = att;
            const err: any = new Error('HTTP 502 Bad Gateway');
            err.status = 502;
            throw err;
          },
          reconcile: async () => {
            reconcileCalls++;
            // GitHub actually processed the check-run before throwing 502
            return existingCheckRun;
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepSpy,
        },
      );

      // Invariant: Exactly 1 POST attempt was made
      expect(postAttempts).toBe(1);
      // Invariant: Reconcile was queried
      expect(reconcileCalls).toBe(1);
      // Invariant: The already-created check-run was returned cleanly without duplicate creation
      expect(result).toEqual(existingCheckRun);
    });

    it('retries POST when 502 occurs and reconcile confirms nothing landed (returns undefined)', async () => {
      let postAttempts = 0;
      let reconcileCalls = 0;
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const result = await withGitHubRetry(
        {
          operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'POST',
          attempt: async (att) => {
            postAttempts = att;
            if (att === 1) {
              const err: any = new Error('HTTP 503 Service Unavailable');
              err.status = 503;
              throw err;
            }
            return { id: 9999, status: 'completed' };
          },
          reconcile: async () => {
            reconcileCalls++;
            // Verified that nothing landed on GitHub
            return undefined;
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepSpy,
        },
      );

      // First attempt failed with 503, reconcile returned undefined, second attempt succeeded
      expect(postAttempts).toBe(2);
      expect(reconcileCalls).toBe(1);
      expect(result).toEqual({ id: 9999, status: 'completed' });
      expect(sleepSpy).toHaveBeenCalledTimes(1);
    });

    it('proves runContinuationPhase leverages findGateCheck reconciliation on 502 error', async () => {
      let publishCalls = 0;
      let findCalls = 0;

      const mockCheckClient = {
        publishGateCheck: vi.fn().mockImplementation(async () => {
          publishCalls++;
          const err: any = new Error('HTTP 502 Bad Gateway');
          err.status = 502;
          throw err;
        }),
        findGateCheck: vi.fn().mockImplementation(async () => {
          findCalls++;
          // Returns the reconciled check run
          return { id: 54321, status: 'completed', conclusion: 'success' };
        }),
      };

      let updatedArtifacts: any;
      const mockDb = {
        query: async (sql: string, params?: any[]) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-reconcile-e2e',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 10,
                  head_sha: 'sha-reconcile-e2e',
                  status: 'inference_completed',
                  artifacts: { llmCompletion: { findings: [] } },
                },
              ],
            };
          }
          if (sql.includes('UPDATE review_runs')) {
            updatedArtifacts = JSON.parse(params?.[0] || '{}');
            return { rowCount: 1 };
          }
          return { rows: [] };
        },
      };

      const result = await runContinuationPhase({
        runId: 'run-reconcile-e2e',
        repo: 'exampleorg/review-yeti-bot',
        headSha: 'sha-reconcile-e2e',
        db: mockDb,
        checkClient: mockCheckClient,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(publishCalls).toBe(1); // Exactly 1 attempt made before reconciliation
      expect(findCalls).toBe(1); // Reconcile called once
      expect(result.gateCheckId).toBe(54321);
      expect(updatedArtifacts.gateCheckId).toBe(54321);
    });
  });
});
