import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isContinuationPhase,
  evaluateGatePolicy,
  formatContinuationSummary,
  loadContinuationState,
  runContinuationPhase,
  type ContinuationPhaseResult,
} from '../../src/review/continuationPhase';
import { shallowFetchHead } from '../../src/review/prepPhase';
import { runWorker } from '../../src/cli/runLiveReview';

describe('Milestone 4: Ephemeral Continuation Pod Execution & Gate Evaluation (Requirement R5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Phase Dispatching Detection (isContinuationPhase)', () => {
    it('detects continuation phase via environment variable CT_PHASE=continuation', () => {
      expect(isContinuationPhase({ CT_PHASE: 'continuation' }, [])).toBe(true);
      expect(isContinuationPhase({ CT_PHASE: 'prep' }, [])).toBe(false);
      expect(isContinuationPhase({}, [])).toBe(false);
    });

    it('detects continuation phase via command line argument --phase=continuation', () => {
      expect(isContinuationPhase({}, ['node', 'cli.js', '--phase=continuation'])).toBe(true);
      expect(isContinuationPhase({}, ['node', 'cli.js', '--phase=prep'])).toBe(false);
    });

    it('detects continuation phase via split command line argument --phase continuation', () => {
      expect(isContinuationPhase({}, ['node', 'cli.js', '--phase', 'continuation'])).toBe(true);
      expect(isContinuationPhase({}, ['node', 'cli.js', '--phase', 'prep'])).toBe(false);
    });
  });

  describe('2. Git Shallow Fetch (<800ms) directly into /workspace', () => {
    it('verifies shallow fetch stub contract in test mode (< 1500ms)', async () => {
      const result = await shallowFetchHead({
        workspacePath: '/tmp/test-continuation-workspace',
        repo: 'calltelemetry/review-yeti-bot',
        headSha: '0123456789abcdef0123456789abcdef01234567',
      });
      expect(result.sha).toBe('0123456789abcdef0123456789abcdef01234567');
      expect(result.durationMs).toBeLessThan(1500);
      expect(result.success).toBe(true);
    });
  });

  describe('3. PostgreSQL State Loading & Precondition Verification', () => {
    it('loads triage state and LLM findings from review_runs artifacts', async () => {
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-cont-001',
                  repo: 'calltelemetry/review-yeti-bot',
                  pr_number: 10,
                  head_sha: 'head-sha-1',
                  base_sha: 'base-sha-1',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      rawOutput: 'Found 1 issue',
                      findings: [
                        {
                          severity: 'P1',
                          file: 'src/index.ts',
                          line: 25,
                          title: 'Unhandled error',
                          description: 'Promise rejection not caught',
                        },
                      ],
                    },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const loaded = await loadContinuationState(mockDb, 'run-cont-001');
      expect(loaded.alreadyCompleted).toBe(false);
      expect(loaded.run.runId).toBe('run-cont-001');
      expect(loaded.llmCompletion.findings).toHaveLength(1);
      expect(loaded.llmCompletion.findings[0].severity).toBe('P1');
    });

    it('loads from review_run_artifacts when artifacts.llmCompletion is absent in review_runs', async () => {
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-cont-002',
                  repo: 'calltelemetry/review-yeti-bot',
                  pr_number: 11,
                  head_sha: 'head-sha-2',
                  status: 'resumption_ready',
                  artifacts: {},
                },
              ],
            };
          }
          if (sql.includes('review_run_artifacts')) {
            return {
              rows: [
                {
                  payload: JSON.stringify({
                    findings: [
                      {
                        severity: 'P2',
                        file: 'README.md',
                        line: 1,
                        title: 'Typo in docs',
                        description: 'Spelling correction',
                      },
                    ],
                  }),
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const loaded = await loadContinuationState(mockDb, 'run-cont-002');
      expect(loaded.alreadyCompleted).toBe(false);
      expect(loaded.llmCompletion.findings[0].severity).toBe('P2');
    });

    it('fails closed with PRECONDITION_FAILED when run is not found in database', async () => {
      const mockDb = {
        query: async () => ({ rows: [] }),
      };

      await expect(loadContinuationState(mockDb, 'non-existent-run')).rejects.toThrow(
        /PRECONDITION_FAILED: Missing review triage\/LLM state/,
      );
    });

    it('fails closed with PRECONDITION_FAILED when LLM completion is missing', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-missing-llm',
                  status: 'awaiting_inference',
                  artifacts: {},
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(loadContinuationState(mockDb, 'run-missing-llm')).rejects.toThrow(
        /PRECONDITION_FAILED: Missing review triage\/LLM state/,
      );
    });
  });

  describe('4. Idempotency Protection for Already Completed Reviews', () => {
    it('returns cleanly without re-posting when review_runs.status is already completed', async () => {
      const commentPublisherMock = {
        publishReview: vi.fn(),
      };
      const checkClientMock = {
        publishGateCheck: vi.fn(),
      };
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-completed-already',
                  repo: 'calltelemetry/review-yeti-bot',
                  pr_number: 44,
                  head_sha: 'head-sha-comp',
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
        runId: 'run-completed-already',
        repo: 'calltelemetry/review-yeti-bot',
        headSha: 'head-sha-comp',
        db: mockDb,
        commentPublisher: commentPublisherMock,
        checkClient: checkClientMock,
        suppressExit: true,
        env: {},
      });

      expect(result.ok).toBe(true);
      expect(result.alreadyCompleted).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(commentPublisherMock.publishReview).not.toHaveBeenCalled();
      expect(checkClientMock.publishGateCheck).not.toHaveBeenCalled();
      // Confirm no UPDATE query was issued to mutate review_runs
      expect(queries.some((q) => q.sql.includes('UPDATE'))).toBe(false);
    });
  });

  describe('5. Gate Policy & Quorum Arbitration', () => {
    it('evaluates P0 finding to BLOCK verdict and failure conclusion', () => {
      const result = evaluateGatePolicy([
        {
          severity: 'P0',
          file: 'auth.ts',
          line: 10,
          title: 'Remote Code Execution',
          description: 'Unsanitized eval',
        },
      ]);
      expect(result.verdict).toBe('BLOCK');
      expect(result.conclusion).toBe('failure');
      expect(result.gateTitle).toBe('Review Yeti Gate: Blocked (P0)');
      expect(result.quorumSatisfied).toBe(true);
    });

    it('evaluates P1 finding (no P0) to FIX_FIRST verdict and failure conclusion', () => {
      const result = evaluateGatePolicy([
        {
          severity: 'P1',
          file: 'api.ts',
          line: 55,
          title: 'Missing input validation',
          description: 'Payload could be null',
        },
        {
          severity: 'P2',
          file: 'style.css',
          line: 3,
          title: 'Spacing nit',
          description: 'Trailing whitespace',
        },
      ]);
      expect(result.verdict).toBe('FIX_FIRST');
      expect(result.conclusion).toBe('failure');
      expect(result.gateTitle).toBe('Review Yeti Gate: Failed (FIX_FIRST)');
      expect(result.quorumSatisfied).toBe(true);
    });

    it('evaluates P2 findings only to SHIP verdict and success conclusion', () => {
      const result = evaluateGatePolicy([
        {
          severity: 'P2',
          file: 'docs/index.md',
          line: 12,
          title: 'Typo in heading',
          description: 'Fix typo',
        },
      ]);
      expect(result.verdict).toBe('SHIP');
      expect(result.conclusion).toBe('success');
      expect(result.gateTitle).toBe('Review Yeti Gate: Approved (SHIP)');
      expect(result.quorumSatisfied).toBe(true);
    });

    it('evaluates clean diff (empty findings) to SHIP verdict and success conclusion', () => {
      const result = evaluateGatePolicy([]);
      expect(result.verdict).toBe('SHIP');
      expect(result.conclusion).toBe('success');
      expect(result.gateTitle).toBe('Review Yeti Gate: Approved (SHIP)');
      expect(result.quorumSatisfied).toBe(true);
    });
  });

  describe('6. PR Summary Formatting & Inline Comments', () => {
    it('formats Markdown summary with banner, repo metadata, and findings table', () => {
      const markdown = formatContinuationSummary({
        repo: 'calltelemetry/review-yeti-bot',
        prNumber: 99,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        verdict: 'BLOCK',
        conclusion: 'failure',
        findings: [
          {
            severity: 'P0',
            file: 'src/server.ts',
            line: 42,
            title: 'Critical Vulnerability',
            description: 'Buffer overflow in packet parser',
          },
        ],
      });

      expect(markdown).toContain('Review Yeti Gate: BLOCK');
      expect(markdown).toContain('calltelemetry/review-yeti-bot');
      expect(markdown).toContain('#99');
      expect(markdown).toContain('Critical Vulnerability');
      expect(markdown).toContain('src/server.ts:42');
    });
  });

  describe('7. Comment Publication, Gate Check & GitHub Retry', () => {
    it('publishes review comment and check run using injected publishers with retry support', async () => {
      const commentPublisherMock = {
        publishReview: vi.fn().mockResolvedValue({ success: true, commentsCreated: 1 }),
      };
      let checkAttempts = 0;
      const checkClientMock = {
        publishGateCheck: vi.fn().mockImplementation(async () => {
          checkAttempts++;
          if (checkAttempts === 1) {
            const err: any = new Error('HTTP 429: rate limit exceeded');
            err.status = 429;
            throw err;
          }
          return 98765;
        }),
      };

      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-post-test',
                  repo: 'calltelemetry/review-yeti-bot',
                  pr_number: 101,
                  head_sha: 'sha-post-test',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      rawOutput: 'Found 1 blocker',
                      findings: [
                        {
                          severity: 'P0',
                          file: 'auth.ts',
                          line: 5,
                          title: 'Hardcoded Secret',
                          description: 'Remove API token',
                        },
                      ],
                    },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const result = await runContinuationPhase({
        runId: 'run-post-test',
        repo: 'calltelemetry/review-yeti-bot',
        headSha: 'sha-post-test',
        db: mockDb,
        commentPublisher: commentPublisherMock,
        checkClient: checkClientMock,
        suppressExit: true,
        env: {},
      });

      expect(result.ok).toBe(true);
      expect(result.commentPosted).toBe(true);
      expect(result.checkUpdated).toBe(true);
      expect(result.gateCheckId).toBe(98765);
      expect(checkAttempts).toBe(2); // Retried once after 429 and succeeded
      expect(commentPublisherMock.publishReview).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'calltelemetry',
          repo: 'review-yeti-bot',
          prNumber: 101,
          event: 'REQUEST_CHANGES',
        }),
      );
    });
  });

  describe('8. Execution Timeout Guard (<60s)', () => {
    it('aborts continuation execution if timeoutMs threshold is exceeded', async () => {
      const mockDb = {
        query: async () => {
          // Simulate hung database query
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { rows: [] };
        },
      };

      await expect(
        runContinuationPhase({
          runId: 'run-timeout-test',
          repo: 'calltelemetry/review-yeti-bot',
          headSha: 'sha-timeout',
          db: mockDb,
          timeoutMs: 50, // 50ms timeout
          suppressExit: true,
          env: {},
        }),
      ).rejects.toThrow(/timeout guard/);
    });
  });

  describe('9. PostgreSQL State Persistence to Completed', () => {
    it('updates review_runs status to completed and records completion timestamp', async () => {
      const queries: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb = {
        query: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (sql.includes('SELECT')) {
            return {
              rows: [
                {
                  run_id: 'run-db-persist',
                  repo: 'calltelemetry/review-yeti-bot',
                  pr_number: 12,
                  head_sha: 'sha-persist',
                  status: 'inference_completed',
                  artifacts: {
                    llmCompletion: {
                      rawOutput: 'Clean PR',
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

      const result = await runContinuationPhase({
        runId: 'run-db-persist',
        repo: 'calltelemetry/review-yeti-bot',
        headSha: 'sha-persist',
        db: mockDb,
        suppressExit: true,
        env: {},
      });

      expect(result.ok).toBe(true);
      expect(result.verdict).toBe('SHIP');

      const updateQuery = queries.find((q) => q.sql.includes('UPDATE review_runs'));
      expect(updateQuery).toBeDefined();
      expect(updateQuery?.sql).toContain("status = 'completed'");
      expect(updateQuery?.sql).toContain("stage = 'continuation_completed'");
      expect(updateQuery?.sql).toContain('completed_at = CURRENT_TIMESTAMP');
      expect(updateQuery?.params).toContain('run-db-persist');
    });
  });

  describe('10. CLI Entrypoint Integration in runWorker', () => {
    it('intercepts CT_PHASE=continuation and invokes continuation runner cleanly', async () => {
      let continuationRan = false;
      const continuationRunner = async () => {
        continuationRan = true;
      };

      const exitMock = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

      await runWorker(
        { CT_PHASE: 'continuation' } as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        undefined as any,
        continuationRunner,
      );

      expect(continuationRan).toBe(true);
      expect(exitMock).toHaveBeenCalledWith(0);
    });
  });
});
