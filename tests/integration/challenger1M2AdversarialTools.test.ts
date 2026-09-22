import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
} from '../../src/mcp/server/remoteMcpRouter';
import {
  GetReviewStatusInputSchema,
  GetReviewFindingsInputSchema,
  GetModelMatrixInputSchema,
  TriggerReviewInputSchema,
  CancelReviewInputSchema,
  WatchReviewProgressInputSchema,
  PreflightDiffReviewInputSchema,
  ExplainFindingInputSchema,
  MAX_PREFLIGHT_DIFF_BYTES,
} from '../../src/mcp/server/tools/schemas';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { createGetReviewFindingsTool } from '../../src/mcp/server/tools/getReviewFindings';
import { createGetModelMatrixTool } from '../../src/mcp/server/tools/getModelMatrix';
import { createTriggerReviewTool } from '../../src/mcp/server/tools/triggerReview';
import { createCancelReviewTool } from '../../src/mcp/server/tools/cancelReview';
import { createWatchReviewProgressTool } from '../../src/mcp/server/tools/watchReviewProgress';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';
import {
  type McpAuthenticator,
  type McpAuthenticatedCaller,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';

describe('Milestone 2 Challenger 1: Adversarial Tool Input & Boundary Verification Suite', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let mockDb: any;

  const validToken = 'valid-challenger-m2-token';
  const allowedOwner = 'calltelemetry';
  const allowedRepo = 'cisco-cdr';

  beforeEach(() => {
    mockDb = {
      query: vi.fn(async (sql: string, params?: any[]) => {
        // Return empty rows by default unless specialized in individual tests
        return { rows: [] };
      }),
    };

    const authenticator: McpAuthenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${validToken}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest_challenger_m2',
            isAdmin: false,
            allowedRepositories: new Set([
              `${allowedOwner}/${allowedRepo}`,
              'calltelemetry/pr-manager-mcp',
            ]),
            callerId: 'challenger-agent-m2',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === validToken) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest_challenger_m2',
            isAdmin: false,
            allowedRepositories: new Set([`${allowedOwner}/${allowedRepo}`]),
            callerId: 'challenger-agent-m2',
          };
        }
        throw new McpAuthError('Unauthorized');
      }) as any,
      checkRepositoryAccess: vi.fn(
        (caller: McpAuthenticatedCaller, owner: string, repo: string) => {
          if (caller.isAdmin) return true;
          return (
            caller.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ??
            false
          );
        }
      ),
      middleware: vi.fn(),
    } as unknown as McpAuthenticator;

    router = createRemoteMcpRouter({
      authenticator,
      db: mockDb,
    });

    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/mcp', router);
  });

  afterEach(() => {
    router.destroy();
  });

  async function invokeTool(toolName: string, args: Record<string, unknown>, id = 1) {
    const res = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      });
    return res;
  }

  // ===========================================================================
  // CATEGORY 1: MALFORMED INPUTS
  // ===========================================================================

  describe('Category 1: Malformed Inputs (Type Violations, Non-Numeric IDs, Invalid Enums, Non-Hex SHAs)', () => {
    describe('1.1 Non-Numeric and Invalid Pull Numbers', () => {
      const invalidPullNumbers = [
        { label: 'string letters', val: 'not-a-number' },
        { label: 'string numeric', val: '42' },
        { label: 'null value', val: null },
        { label: 'boolean true', val: true },
        { label: 'array of number', val: [42] },
        { label: 'object representation', val: { pr: 42 } },
        { label: 'negative integer', val: -1 },
        { label: 'negative large integer', val: -99999 },
        { label: 'zero', val: 0 },
        { label: 'floating point float', val: 42.5 },
        { label: 'floating point pi', val: 3.14159 },
        { label: 'Infinity', val: Infinity },
      ];

      it.each(invalidPullNumbers)(
        'get_review_status rejects $label ($val)',
        async ({ val }) => {
          const res = await invokeTool('get_review_status', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: val,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool get_review_status');
        }
      );

      it.each(invalidPullNumbers)(
        'get_review_findings rejects $label ($val)',
        async ({ val }) => {
          const res = await invokeTool('get_review_findings', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: val,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool get_review_findings');
        }
      );

      it.each(invalidPullNumbers)(
        'trigger_review rejects $label ($val)',
        async ({ val }) => {
          const res = await invokeTool('trigger_review', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: val,
            head_sha: 'a'.repeat(40),
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool trigger_review');
        }
      );

      it.each(invalidPullNumbers)(
        'cancel_review rejects $label ($val)',
        async ({ val }) => {
          const res = await invokeTool('cancel_review', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: val,
            reason: 'Cancelling test PR',
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool cancel_review');
        }
      );

      it.each(invalidPullNumbers)(
        'watch_review_progress rejects $label ($val)',
        async ({ val }) => {
          const res = await invokeTool('watch_review_progress', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: val,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool watch_review_progress');
        }
      );
    });

    describe('1.2 Invalid Commit SHAs', () => {
      describe('trigger_review requires strict 40-character hexadecimal SHA', () => {
        const invalidStrict40Shas = [
          { label: '39 hex chars (too short)', sha: 'a'.repeat(39) },
          { label: '41 hex chars (too long)', sha: 'a'.repeat(41) },
          { label: '7 hex chars (short SHA)', sha: 'a1b2c3d' },
          { label: '64 hex chars (SHA-256)', sha: 'a'.repeat(64) },
          { label: 'empty string', sha: '' },
          { label: 'whitespace string', sha: '   ' },
          { label: '40 chars containing non-hex letter z', sha: 'a'.repeat(39) + 'z' },
          { label: '40 chars containing non-hex letter g', sha: 'g'.repeat(40) },
          { label: '40 chars containing punctuation', sha: 'a'.repeat(39) + '!' },
          { label: '40 chars containing newline', sha: 'a'.repeat(39) + '\n' },
          { label: '40 chars containing spaces', sha: 'a'.repeat(20) + ' ' + 'a'.repeat(19) },
          { label: 'SQL injection string', sha: "a".repeat(20) + "' OR '1'='1" },
        ];

        it.each(invalidStrict40Shas)(
          'rejects $label',
          async ({ sha }) => {
            const res = await invokeTool('trigger_review', {
              owner: allowedOwner,
              repo: allowedRepo,
              pull_number: 100,
              head_sha: sha,
            });

            expect(res.status).toBe(200);
            expect(res.body.error).toBeDefined();
            expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
            expect(res.body.error.message).toContain('head_sha must be a 40-character hexadecimal commit SHA');
          }
        );
      });

      describe('get_review_status and watch_review_progress flex commit SHA (7 to 64 hex chars)', () => {
        const invalidFlexShas = [
          { label: '6 hex chars (below 7 minimum)', sha: 'a'.repeat(6) },
          { label: '65 hex chars (above 64 maximum)', sha: 'a'.repeat(65) },
          { label: 'non-hex chars in 40-char string', sha: 'z'.repeat(40) },
          { label: 'whitespace inside SHA', sha: 'a'.repeat(20) + ' ' + 'a'.repeat(19) },
          { label: 'path traversal string', sha: '../../etc/passwd' },
        ];

        it.each(invalidFlexShas)(
          'get_review_status rejects $label',
          async ({ sha }) => {
            const res = await invokeTool('get_review_status', {
              owner: allowedOwner,
              repo: allowedRepo,
              pull_number: 100,
              head_sha: sha,
            });

            expect(res.status).toBe(200);
            expect(res.body.error).toBeDefined();
            expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
            expect(res.body.error.message).toContain('head_sha');
          }
        );

        it.each(invalidFlexShas)(
          'watch_review_progress rejects $label',
          async ({ sha }) => {
            const res = await invokeTool('watch_review_progress', {
              owner: allowedOwner,
              repo: allowedRepo,
              pull_number: 100,
              head_sha: sha,
            });

            expect(res.status).toBe(200);
            expect(res.body.error).toBeDefined();
            expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
            expect(res.body.error.message).toContain('head_sha');
          }
        );
      });
    });

    describe('1.3 Invalid Severity Enums in get_review_findings', () => {
      const invalidSeverities = [
        { label: 'CRITICAL (legacy string)', sev: 'CRITICAL' },
        { label: 'HIGH (legacy string)', sev: 'HIGH' },
        { label: 'MEDIUM (legacy string)', sev: 'MEDIUM' },
        { label: 'LOW (legacy string)', sev: 'LOW' },
        { label: 'P3 (out of bounds)', sev: 'P3' },
        { label: 'P-1 (negative)', sev: 'P-1' },
        { label: 'lowercase p0', sev: 'p0' },
        { label: 'lowercase p1', sev: 'p1' },
        { label: 'lowercase p2', sev: 'p2' },
        { label: 'numeric 0', sev: 0 },
        { label: 'numeric 1', sev: 1 },
        { label: 'empty string', sev: '' },
        { label: 'boolean true', sev: true },
        { label: 'SQL payload', sev: "P0' OR '1'='1" },
      ];

      it.each(invalidSeverities)(
        'rejects invalid severity enum $label ($sev)',
        async ({ sev }) => {
          const res = await invokeTool('get_review_findings', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: 100,
            severity: sev,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('Invalid parameters for tool get_review_findings');
        }
      );

      it('accepts valid severity enums: P0, P1, P2', async () => {
        for (const validSev of ['P0', 'P1', 'P2']) {
          const res = await invokeTool('get_review_findings', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: 100,
            severity: validSev,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeUndefined();
          expect(res.body.result).toBeDefined();
        }
      });
    });

    describe('1.4 Empty and Blank Strings in Mandatory Text Fields', () => {
      it('rejects empty owner and repo strings via schema validation', async () => {
        const resEmptyOwner = await invokeTool('get_review_status', {
          owner: '',
          repo: allowedRepo,
          pull_number: 10,
        });
        expect(resEmptyOwner.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(resEmptyOwner.body.error.message).toContain('owner must not be empty');

        const resEmptyRepo = await invokeTool('get_review_status', {
          owner: allowedOwner,
          repo: '',
          pull_number: 10,
        });
        expect(resEmptyRepo.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(resEmptyRepo.body.error.message).toContain('repo must not be empty');
      });

      it('blocks unauthorized or whitespace-only repository access via fail-closed RBAC or schema validation', async () => {
        const resWhitespaceRepo = await invokeTool('get_review_status', {
          owner: allowedOwner,
          repo: '   ',
          pull_number: 10,
        });
        // Fails RBAC tenancy check because caller has no permission for 'calltelemetry/   '
        expect(resWhitespaceRepo.status).toBe(403);
        expect(resWhitespaceRepo.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      });

      it('rejects empty reason string in cancel_review', async () => {
        const resEmpty = await invokeTool('cancel_review', {
          owner: allowedOwner,
          repo: allowedRepo,
          pull_number: 10,
          reason: '',
        });
        expect(resEmpty.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(resEmpty.body.error.message).toContain('reason is required for audit trail');

        const resWhitespace = await invokeTool('cancel_review', {
          owner: allowedOwner,
          repo: allowedRepo,
          pull_number: 10,
          reason: '     ',
        });
        expect(resWhitespace.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      });

      it('rejects empty finding_id and question in explain_finding', async () => {
        const resEmptyId = await invokeTool('explain_finding', {
          finding_id: '',
          question: 'How do I fix this?',
        });
        expect(resEmptyId.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(resEmptyId.body.error.message).toContain('finding_id is required');

        const resEmptyQ = await invokeTool('explain_finding', {
          finding_id: 'FINDING-1234',
          question: '   ',
        });
        expect(resEmptyQ.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(resEmptyQ.body.error.message).toContain('question is required');
      });
    });

    describe('1.5 Strict Object Schema Violation (Additional / Unexpected Properties)', () => {
      it('rejects unexpected properties in get_review_status', async () => {
        const res = await invokeTool('get_review_status', {
          owner: allowedOwner,
          repo: allowedRepo,
          pull_number: 10,
          extra_malicious_prop: true,
        });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toContain('Unrecognized key(s)');
      });

      it('rejects unexpected properties in trigger_review', async () => {
        const res = await invokeTool('trigger_review', {
          owner: allowedOwner,
          repo: allowedRepo,
          pull_number: 10,
          head_sha: 'a'.repeat(40),
          injected_admin_override: true,
        });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toContain('Unrecognized key(s)');
      });

      it('rejects unexpected properties in explain_finding', async () => {
        const res = await invokeTool('explain_finding', {
          finding_id: 'FINDING-01',
          question: 'What is this?',
          bypass_policy: true,
        });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
        expect(res.body.error.message).toContain('Unrecognized key(s)');
      });
    });
  });

  // ===========================================================================
  // CATEGORY 2: NON-EXISTENT ENTITIES
  // ===========================================================================

  describe('Category 2: Non-Existent Entities & Unregistered Identifiers', () => {
    it('get_review_status returns graceful found: false for PR with zero review records', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const res = await invokeTool('get_review_status', {
        owner: allowedOwner,
        repo: allowedRepo,
        pull_number: 99999999,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      expect(res.body.result).toBeDefined();
      const content = JSON.parse(res.body.result.content[0].text);

      expect(content.found).toBe(false);
      expect(content.verdict).toBe('PENDING');
      expect(content.phase).toBe('queued');
      expect(content.attempt_id).toBeNull();
      expect(content.check_run).toBeNull();
      expect(content.active_worker).toBeNull();
      expect(content.message).toContain('No review run found for calltelemetry/cisco-cdr PR #99999999');
    });

    it('get_review_findings returns empty list for PR with zero review findings', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // completions
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // artifacts
      mockDb.query.mockResolvedValueOnce({ rows: [] }); // runs.artifacts

      const res = await invokeTool('get_review_findings', {
        owner: allowedOwner,
        repo: allowedRepo,
        pull_number: 88888888,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);

      expect(content.findings).toEqual([]);
      expect(content.total_count).toBe(0);
      expect(content.unresolved_count).toBe(0);
    });

    it('cancel_review returns graceful JSON-RPC error when cancelling non-existent active PR', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const res = await invokeTool('cancel_review', {
        owner: allowedOwner,
        repo: allowedRepo,
        pull_number: 77777777,
        reason: 'Attempting to cancel non-existent run',
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INTERNAL_ERROR);
      expect(res.body.error.message).toContain(
        'Not Found: No active review run found for calltelemetry/cisco-cdr PR #77777777 to cancel'
      );
    });

    it('explain_finding returns graceful non-crashing explanation when finding_id is not in ledger', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const nonExistentFindingId = 'finding-nonexistent-uuid-999-xyz';
      const res = await invokeTool('explain_finding', {
        finding_id: nonExistentFindingId,
        question: 'Can you explain why this was flagged?',
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);

      expect(content.explanation).toBe(
        `Finding '${nonExistentFindingId}' was not found in the review ledger. Please confirm the finding ID from get_review_findings.`
      );
      expect(content.satisfies_requirement).toBeNull();
      expect(content.citations).toEqual([]);
    });
  });

  // ===========================================================================
  // CATEGORY 3: BOUNDARY PARAMETERS (DIFF SIZES & EDGE CHARACTERS)
  // ===========================================================================

  describe('Category 3: Boundary Parameters (Diffs: Empty, Whitespace, 512KB Threshold, Unicode)', () => {
    it('rejects empty string diff (diff cannot be empty)', async () => {
      const res = await invokeTool('preflight_diff_review', {
        diff: '',
        repo: allowedRepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('diff cannot be empty');
    });

    it('handles whitespace-only diffs without crashing', async () => {
      const whitespaceDiff = '   \n\t  \n  \r\n   ';
      const res = await invokeTool('preflight_diff_review', {
        diff: whitespaceDiff,
        repo: allowedRepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);

      expect(content.eligible_to_ship).toBe(true);
      expect(content.findings).toEqual([]);
      expect(content.blast_radius_summary).toContain('0 files modified');
    });

    it('accepts diffs of exactly 512KB (524,288 bytes)', async () => {
      const prefix = 'diff --git a/test.txt b/test.txt\n--- a/test.txt\n+++ b/test.txt\n@@ -1,1 +1,1 @@\n+';
      const fillLength = MAX_PREFLIGHT_DIFF_BYTES - Buffer.byteLength(prefix, 'utf8');
      const exact512KbDiff = prefix + 'x'.repeat(fillLength);

      expect(Buffer.byteLength(exact512KbDiff, 'utf8')).toBe(MAX_PREFLIGHT_DIFF_BYTES);

      const res = await invokeTool('preflight_diff_review', {
        diff: exact512KbDiff,
        repo: allowedRepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.eligible_to_ship).toBe(true);
    });

    it('rejects diffs exceeding 512KB by 1 byte (524,289 bytes)', async () => {
      const oversizedDiff = 'x'.repeat(MAX_PREFLIGHT_DIFF_BYTES + 1);
      expect(Buffer.byteLength(oversizedDiff, 'utf8')).toBe(MAX_PREFLIGHT_DIFF_BYTES + 1);

      const res = await invokeTool('preflight_diff_review', {
        diff: oversizedDiff,
        repo: allowedRepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('diff exceeds maximum allowed size of 512KB');
    });

    it('correctly calculates byte length for multi-byte Unicode strings (character count < 512K but byte count > 512KB)', async () => {
      // 4-byte UTF-8 emoji: 🚀 (4 bytes each)
      // 135,000 emojis = 135,000 * 4 = 540,000 bytes (> 512KB)
      const emojiString = '🚀'.repeat(135_000);
      expect(emojiString.length).toBe(270_000); // 2 UTF-16 code units each
      expect(Buffer.byteLength(emojiString, 'utf8')).toBe(540_000);

      const res = await invokeTool('preflight_diff_review', {
        diff: emojiString,
        repo: allowedRepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('diff exceeds maximum allowed size of 512KB');
    });
  });

  // ===========================================================================
  // CATEGORY 4: SORTING AND LIMITS ON GET_MODEL_MATRIX
  // ===========================================================================

  describe('Category 4: Sorting, Benchmark Types, and Limits on get_model_matrix', () => {
    describe('4.1 Negative and Zero Limits', () => {
      const invalidNegativeLimits = [
        { label: 'negative one', lim: -1 },
        { label: 'zero', lim: 0 },
        { label: 'negative hundred', lim: -100 },
        { label: 'float', lim: 10.5 },
      ];

      it.each(invalidNegativeLimits)(
        'rejects limit $label ($lim)',
        async ({ lim }) => {
          const res = await invokeTool('get_model_matrix', {
            limit: lim,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toMatch(/limit|integer|float/);
        }
      );
    });

    describe('4.2 Oversized Limits (> 100)', () => {
      const oversizedLimits = [
        { label: '101 (just above maximum 100)', lim: 101 },
        { label: '200', lim: 200 },
        { label: '1000', lim: 1000 },
        { label: '1000000', lim: 1_000_000 },
      ];

      it.each(oversizedLimits)(
        'rejects oversized limit $label ($lim)',
        async ({ lim }) => {
          const res = await invokeTool('get_model_matrix', {
            limit: lim,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toContain('limit must be <= 100');
        }
      );
    });

    describe('4.3 Invalid Sort Keys and Benchmark Types', () => {
      const invalidSortKeys = [
        { label: 'price (not in enum)', key: 'price' },
        { label: 'score (not in enum)', key: 'score' },
        { label: 'bench (not in enum)', key: 'bench' },
        { label: 'uppercase SWE-SCORE', key: 'SWE-SCORE' },
        { label: 'empty string', key: '' },
        { label: 'numeric 1', key: 1 },
        { label: 'SQL injection string', key: "swe-score'; DROP TABLE models; --" },
      ];

      it.each(invalidSortKeys)(
        'rejects invalid sort_by key $label ($key)',
        async ({ key }) => {
          const res = await invokeTool('get_model_matrix', {
            sort_by: key,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toMatch(/Expected 'swe-score'|sort_by/);
        }
      );

      const invalidBenchmarks = [
        { label: 'full', bm: 'full' },
        { label: 'pro', bm: 'pro' },
        { label: 'swe-bench', bm: 'swe-bench' },
        { label: 'standard', bm: 'standard' },
        { label: 'VERIFIED (uppercase)', bm: 'VERIFIED' },
      ];

      it.each(invalidBenchmarks)(
        'rejects invalid benchmark_type $label ($bm)',
        async ({ bm }) => {
          const res = await invokeTool('get_model_matrix', {
            benchmark_type: bm,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeDefined();
          expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
          expect(res.body.error.message).toMatch(/Expected 'verified'|benchmark_type/);
        }
      );
    });

    describe('4.4 Valid Boundaries on get_model_matrix', () => {
      it('accepts boundary limit of 1 and returns exactly 1 model', async () => {
        const res = await invokeTool('get_model_matrix', {
          limit: 1,
          sort_by: 'swe-score',
          benchmark_type: 'verified',
        });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        const content = JSON.parse(res.body.result.content[0].text);
        expect(content.returned_models).toBe(1);
        expect(content.models.length).toBe(1);
      });

      it('accepts boundary limit of 100', async () => {
        const res = await invokeTool('get_model_matrix', {
          limit: 100,
          sort_by: 'cost',
          benchmark_type: 'lite',
        });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        const content = JSON.parse(res.body.result.content[0].text);
        expect(content.returned_models).toBeLessThanOrEqual(100);
      });

      it.each(['swe-score', 'cost', 'efficiency', 'context', 'name'] as const)(
        'accepts valid sort_by field: %s',
        async (sortField) => {
          const res = await invokeTool('get_model_matrix', {
            sort_by: sortField,
            limit: 5,
          });

          expect(res.status).toBe(200);
          expect(res.body.error).toBeUndefined();
        }
      );
    });
  });

  // ===========================================================================
  // CATEGORY 5: CONCURRENT STRESS & DIRECT SCHEMA HARNESS
  // ===========================================================================

  describe('Category 5: Direct Schema Harness & Stress Validations', () => {
    it('PreflightDiffReviewInputSchema directly asserts byte length boundary', () => {
      const valid512Kb = 'a'.repeat(MAX_PREFLIGHT_DIFF_BYTES);
      const invalid512KbPlusOne = 'a'.repeat(MAX_PREFLIGHT_DIFF_BYTES + 1);

      expect(
        PreflightDiffReviewInputSchema.safeParse({
          diff: valid512Kb,
          repo: 'cisco-cdr',
        }).success
      ).toBe(true);

      const invalidResult = PreflightDiffReviewInputSchema.safeParse({
        diff: invalid512KbPlusOne,
        repo: 'cisco-cdr',
      });
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        expect(invalidResult.error.issues[0].message).toContain('exceeds maximum allowed size of 512KB');
      }
    });

    it('WatchReviewProgressInputSchema asserts timeout_seconds bounds [1, 900]', () => {
      expect(
        WatchReviewProgressInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          timeout_seconds: 0,
        }).success
      ).toBe(false);

      expect(
        WatchReviewProgressInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          timeout_seconds: 901,
        }).success
      ).toBe(false);

      expect(
        WatchReviewProgressInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          timeout_seconds: 1,
        }).success
      ).toBe(true);

      expect(
        WatchReviewProgressInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          timeout_seconds: 900,
        }).success
      ).toBe(true);
    });

    it('TriggerReviewInputSchema asserts priority enum [normal, expedited]', () => {
      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          head_sha: 'a'.repeat(40),
          priority: 'urgent',
        }).success
      ).toBe(false);

      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          head_sha: 'a'.repeat(40),
          priority: 'normal',
        }).success
      ).toBe(true);

      expect(
        TriggerReviewInputSchema.safeParse({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 1,
          head_sha: 'a'.repeat(40),
          priority: 'expedited',
        }).success
      ).toBe(true);
    });

    it('handles 50 concurrent adversarial malformed requests without unhandled crashes', async () => {
      const requests = Array.from({ length: 50 }, (_, i) => {
        // Interleave various malformed calls
        if (i % 4 === 0) {
          return invokeTool('get_review_status', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: 'non-numeric-' + i,
          }, i + 100);
        } else if (i % 4 === 1) {
          return invokeTool('get_review_findings', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: 10,
            severity: 'INVALID_SEV_' + i,
          }, i + 100);
        } else if (i % 4 === 2) {
          return invokeTool('get_model_matrix', {
            limit: -i - 1,
          }, i + 100);
        } else {
          return invokeTool('trigger_review', {
            owner: allowedOwner,
            repo: allowedRepo,
            pull_number: 10,
            head_sha: 'too_short_' + i,
          }, i + 100);
        }
      });

      const responses = await Promise.all(requests);
      expect(responses.length).toBe(50);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.error).toBeDefined();
        expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      }
    });
  });
});
