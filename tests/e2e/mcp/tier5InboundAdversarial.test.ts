/**
 * Tier 5: Adversarial Coverage Hardening Test Suite
 *
 * White-box coverage, boundary testing, exception handling, and edge case hardening
 * for Inbound Tools and Engine Selection:
 * 1. Remote MCP Router Protocol Hardening (Batch JSON-RPC, Session Reaper, Headers)
 * 2. RBAC & Repository Resolution Normalization (Unqualified repos, single-string parsing, fail-closed)
 * 3. Native MCP Resources & Real-Time SSE Subscriptions (Catalog, Read, Subscribe, Event Notification)
 * 4. Preflight Diff Review White-Box AST & Severity Calibration (CRLF, Non-git headers, Confidence filter)
 * 5. Fix Diff Generation White-Box Git Synthesis & Verification (git apply --check, Fallback chains, Add/Del)
 * 6. Dispute Finding Quorum Adjudication & Ledger Blocker Math (Model parse, SSE trigger, Blocker math)
 * 7. Explain Finding Scoping, Multi-Tenant Fail-Closed & Heuristics (Unscoped auth, Bypass vs Compliant)
 * 8. Review Engine Selection (TriggerReview admission propagation, Conflict 409, PublishingWorker selection)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import {
  buildE2eTestEnvironment,
  DIFF_FIXTURES,
  VALID_E2E_TOKEN,
  ADMIN_E2E_TOKEN,
  type E2eTestEnvironment,
} from './harness/mcpE2eHarness';
import {
  resolveReviewEngine,
  runPublishingReviewWorker,
  type PublishingReviewDeps,
} from '../../../src/cli/publishingReview';
import {
  validatePatchWithGitApply,
  synthesizeUnifiedDiff,
  createGenerateFixDiffTool,
} from '../../../src/mcp/server/tools/generateFixDiff';
import {
  defaultAdjudicateFinding,
  evaluateDisputeWithModel,
  createDisputeFindingTool,
} from '../../../src/mcp/server/tools/disputeFinding';
import {
  evaluateWithHeuristics,
  buildExplainPrompt,
  createExplainFindingTool,
  type StoredFindingRecord,
} from '../../../src/mcp/server/tools/explainFinding';
import {
  parseUnifiedDiff,
  createPreflightDiffReviewTool,
} from '../../../src/mcp/server/tools/preflightDiffReview';
import {
  createTriggerReviewTool,
} from '../../../src/mcp/server/tools/triggerReview';
import {
  TriggerReviewInputSchema,
  PreflightDiffReviewInputSchema,
  DisputeFindingInputSchema,
  GenerateFixDiffInputSchema,
  ExplainFindingInputSchema,
} from '../../../src/mcp/server/tools/schemas';
import { createRemoteMcpRouter } from '../../../src/mcp/server/remoteMcpRouter';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../../src/mcp/server/mcpTypes';

describe('Tier 5: Adversarial Coverage Hardening (tests/e2e/mcp/tier5InboundAdversarial.test.ts)', () => {
  let env: E2eTestEnvironment;

  beforeEach(() => {
    env = buildE2eTestEnvironment();
  });

  afterEach(() => {
    env.router.destroy();
  });

  // ===========================================================================
  // Suite 1: Remote MCP Router JSON-RPC Batch & Session Protocol Hardening
  // ===========================================================================
  describe('Suite 1: Remote MCP Router Protocol Hardening', () => {
    it('TC-T5-RPC-01: empty batch array returns HTTP 400 with INVALID_REQUEST', async () => {
      const res = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send([]);

      expect(res.status).toBe(400);
      expect(res.body).toBeDefined();
      expect(res.body.jsonrpc).toBe('2.0');
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
      expect(res.body.error.message).toMatch(/batch is empty/i);
    });

    it('TC-T5-RPC-02: heterogeneous batch request dispatches all calls and preserves response order', async () => {
      const batch = [
        { jsonrpc: '2.0', id: 101, method: 'ping' },
        { jsonrpc: '2.0', id: 102, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'preflight_diff_review',
            arguments: {
              owner: 'calltelemetry',
              repo: 'cisco-cdr',
              diff: DIFF_FIXTURES.safeMarkdown,
            },
          },
        },
      ];

      const res = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send(batch);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(3);

      // Order preserved
      expect(res.body[0].id).toBe(101);
      expect(res.body[0].result).toEqual({});

      expect(res.body[1].id).toBe(102);
      expect(res.body[1].result.tools).toBeInstanceOf(Array);

      expect(res.body[2].id).toBe(103);
      expect(res.body[2].result.content).toBeDefined();
    });

    it('TC-T5-RPC-03: batch containing notification does not emit null elements in response array', async () => {
      const batch = [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 201, method: 'ping' },
      ];

      const res = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send(batch);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(201);
    });

    it('TC-T5-RPC-04: session manager reaper purges idle sessions past sessionTtlMs', () => {
      const createdSession = env.router.sessionManager.createSession();
      expect(env.router.sessionManager.activeSessionCount()).toBeGreaterThanOrEqual(1);

      // Advance time past default 30 min TTL
      const futureTime = Date.now() + 2_000_000;
      const reaped = env.router.sessionManager.reapIdleSessions(futureTime);
      expect(reaped).toBeGreaterThanOrEqual(1);
      expect(env.router.sessionManager.getSession(createdSession.id)).toBeUndefined();
    });

    it('TC-T5-RPC-05: enforces maxSessions ceiling returning HTTP 429 on initialize', async () => {
      const customRouter = createRemoteMcpRouter({
        maxSessions: 1,
        sessionManager: {
          createSession: () => ({
            id: 'mock-s-1',
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
            onCloseCallbacks: [],
            subscriptions: new Set(),
          }),
          getSession: () => undefined,
          touchSession: () => {},
          closeSession: () => {},
          reapIdleSessions: () => 0,
          activeSessionCount: () => 1, // already at max (1)
        },
      });

      const express = require('express');
      const appWithRouter = express();
      appWithRouter.use(express.json());
      appWithRouter.use('/mcp', customRouter);

      const customRes = await request(appWithRouter)
        .post('/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send({ jsonrpc: '2.0', id: 301, method: 'initialize', params: {} });

      expect(customRes.status).toBe(429);
      expect(customRes.body.error.code).toBe(MCP_ERRORS.TOO_MANY_SESSIONS);
      customRouter.destroy();
    });

    it('TC-T5-RPC-06: mcp-session-id header updates lastSeenAt on valid ID, returns 404 on expired ID', async () => {
      const session = env.router.sessionManager.createSession();

      // 1. Valid session ID touches session
      const validRes = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .set('mcp-session-id', session.id)
        .send({ jsonrpc: '2.0', id: 401, method: 'ping' });

      expect(validRes.status).toBe(200);
      expect(validRes.headers['mcp-session-id']).toBe(session.id);

      // 2. Non-existent session ID returns 404
      const invalidRes = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .set('mcp-session-id', 'non-existent-session-id-999')
        .send({ jsonrpc: '2.0', id: 402, method: 'ping' });

      expect(invalidRes.status).toBe(404);
      expect(invalidRes.body.error.code).toBe(MCP_ERRORS.SESSION_EXPIRED);
    });

    it('TC-T5-RPC-07: router destroy safely terminates background timer and active sessions', () => {
      const session = env.router.sessionManager.createSession();
      expect(env.router.sessionManager.activeSessionCount()).toBeGreaterThanOrEqual(1);

      env.router.destroy();
      expect(env.router.sessionManager.activeSessionCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Suite 2: Advanced RBAC & Repository Resolution Normalization
  // ===========================================================================
  describe('Suite 2: Advanced RBAC & Repository Resolution Normalization', () => {
    it('TC-T5-RBAC-01: auto-normalizes single-string owner/repo format in repo parameter when owner is missing', async () => {
      const res = await env.callTool('preflight_diff_review', {
        repo: 'calltelemetry/cisco-cdr',
        diff: DIFF_FIXTURES.cleanCode,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.blast_radius_summary).toBeDefined();
    });

    it('TC-T5-RBAC-02: auto-resolves owner for unqualified repo if caller holds permission in allowedRepositories', async () => {
      // Caller has 'calltelemetry/cisco-cdr' in allowedRepositories
      const res = await env.callTool('preflight_diff_review', {
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.cleanCode,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
    });

    it('TC-T5-RBAC-03: non-admin caller providing incomplete coordinate fails closed with HTTP 403 McpRbacError', async () => {
      // Provide owner without repo
      const res = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 501,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: {
              owner: 'calltelemetry',
              // repo omitted
              pull_number: 10,
            },
          },
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toMatch(/Forbidden: Access to repository .* denied/i);
    });

    it('TC-T5-RBAC-04: empty string coordinates skip RBAC normalization so schema safeParse catches INVALID_PARAMS', async () => {
      const res = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 502,
          method: 'tools/call',
          params: {
            name: 'get_review_status',
            arguments: {
              owner: '',
              repo: '',
              pull_number: 10,
            },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toMatch(/owner must not be empty/i);
    });

    it('TC-T5-RBAC-05: tool dispatch returns INVALID_PARAMS for missing name, METHOD_NOT_FOUND for unknown name', async () => {
      // 1. Missing name
      const resMissing = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 503,
          method: 'tools/call',
          params: { arguments: {} },
        });

      expect(resMissing.status).toBe(200);
      expect(resMissing.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(resMissing.body.error.message).toMatch(/Invalid tool name/i);

      // 2. Unknown tool name
      const resUnknown = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .send({
          jsonrpc: '2.0',
          id: 504,
          method: 'tools/call',
          params: { name: 'nonexistent_tool_xyz', arguments: {} },
        });

      expect(resUnknown.status).toBe(200);
      expect(resUnknown.body.error.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
      expect(resUnknown.body.error.message).toMatch(/Tool not found: nonexistent_tool_xyz/i);
    });
  });

  // ===========================================================================
  // Suite 3: Native MCP Resources & Real-Time SSE Subscriptions
  // ===========================================================================
  describe('Suite 3: Native MCP Resources & Real-Time SSE Subscriptions', () => {
    it('TC-T5-RES-01: resources/list returns complete catalog with supported URI templates', async () => {
      const res = await env.rpcCall('resources/list');
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.resources).toBeInstanceOf(Array);
      expect(res.body.result.resources.length).toBeGreaterThanOrEqual(3);

      const uris = res.body.result.resources.map((r: any) => r.uriTemplate || r.uri);
      expect(uris.some((u: string) => u.includes('review-yeti://runs/'))).toBe(true);
      expect(uris.some((u: string) => u.includes('review-yeti://findings/'))).toBe(true);
      expect(uris.some((u: string) => u.includes('review-yeti://charters/'))).toBe(true);
    });

    it('TC-T5-RES-02: resources/read enforces repository RBAC rejecting cross-tenant URI with HTTP 403', async () => {
      const res = await env.rpcCall('resources/read', {
        uri: 'review-yeti://runs/unauthorized-tenant/secret-repo/42',
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
    });

    it('TC-T5-RES-03: resources/read fetches structured JSON for valid authorized resource URI', async () => {
      env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 105,
        head_sha: 'a'.repeat(40),
        status: 'succeeded',
      });

      const res = await env.rpcCall('resources/read', {
        uri: 'review-yeti://runs/calltelemetry/cisco-cdr/105',
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      expect(res.body.result.contents).toBeDefined();
      const content = JSON.parse(res.body.result.contents[0].text);
      expect(content.owner).toBe('calltelemetry');
      expect(content.repo).toBe('cisco-cdr');
      expect(content.pr_number).toBe(105);
    });

    it('TC-T5-RES-04: resources/subscribe and unsubscribe manage session subscription set', async () => {
      const session = env.router.sessionManager.createSession();
      const uri = 'review-yeti://runs/calltelemetry/cisco-cdr/105';

      // 1. Subscribe
      const subRes = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .set('mcp-session-id', session.id)
        .send({
          jsonrpc: '2.0',
          id: 601,
          method: 'resources/subscribe',
          params: { uri },
        });

      expect(subRes.status).toBe(200);
      expect(session.subscriptions.has(uri)).toBe(true);

      // 2. Unsubscribe
      const unsubRes = await request(env.app)
        .post('/api/mcp')
        .set('Authorization', `Bearer ${VALID_E2E_TOKEN}`)
        .set('mcp-session-id', session.id)
        .send({
          jsonrpc: '2.0',
          id: 602,
          method: 'resources/unsubscribe',
          params: { uri },
        });

      expect(unsubRes.status).toBe(200);
      expect(session.subscriptions.has(uri)).toBe(false);
    });

    it('TC-T5-RES-05: notifyResourceUpdated pushes SSE notification to subscribed session', () => {
      const mockWrite = vi.fn();
      const mockRes: any = {
        writableEnded: false,
        write: mockWrite,
      };

      const session = env.router.sessionManager.createSession(mockRes);
      session.subscriptions.add('review-yeti://findings/calltelemetry/cisco-cdr/105');

      const notified = env.router.notifyResourceUpdated(
        'review-yeti://findings/calltelemetry/cisco-cdr/105',
        { status: 'OVERRULED' }
      );

      expect(notified).toBe(1);
      expect(mockWrite).toHaveBeenCalled();
      const writtenText = mockWrite.mock.calls[0][0];
      expect(writtenText).toContain('notifications/resources/updated');
      expect(writtenText).toContain('review-yeti://findings/calltelemetry/cisco-cdr/105');
      expect(writtenText).toContain('OVERRULED');
    });
  });

  // ===========================================================================
  // Suite 4: Preflight Diff Review White-Box AST & Severity Calibration
  // ===========================================================================
  describe('Suite 4: Preflight Diff Review White-Box AST & Severity Calibration', () => {
    it('TC-T5-PRE-01: diff starting directly with +++ b/path without diff --git header parses accurately', () => {
      const truncatedDiff = `+++ b/src/service/order.ts
@@ -10,2 +10,4 @@
 export function processOrder() {
+  const tax = 0.08;
+  return tax;
 }
`;
      const parsed = parseUnifiedDiff(truncatedDiff);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].path).toBe('src/service/order.ts');
      expect(parsed[0].addedLines).toHaveLength(2);
      expect(parsed[0].modifiedExports).toContain('processOrder');
    });

    it('TC-T5-PRE-02: sensitive path regex overrides safe documentation extension denying fast-ship', async () => {
      // Sensitive path pattern touches /auth/ even with .md extension
      const authDocDiff = `diff --git a/docs/auth/jwt-specification.md b/docs/auth/jwt-specification.md
index 1111111..2222222 100644
--- a/docs/auth/jwt-specification.md
+++ b/docs/auth/jwt-specification.md
@@ -1,2 +1,4 @@
 # JWT Auth Spec
+Tokens expire after 15 minutes.
`;
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: authDocDiff,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      // Blast radius marks CRITICAL due to /auth/ path regex, disqualifying from simple fast-ship bypass
      expect(res.result.blast_radius_summary).toMatch(/CRITICAL/i);
    });

    it('TC-T5-PRE-03: diff with Windows CRLF newlines and No newline at end of file parses cleanly', () => {
      const crlfDiff = 'diff --git a/src/win.ts b/src/win.ts\r\nindex 111..222 100644\r\n--- a/src/win.ts\r\n+++ b/src/win.ts\r\n@@ -1,2 +1,3 @@\r\n export const win = true;\r\n+export const added = 42;\r\n\\ No newline at end of file\r\n';
      const parsed = parseUnifiedDiff(crlfDiff);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].addedLines).toHaveLength(1);
      expect(parsed[0].addedLines[0].text.trim()).toBe('export const added = 42;');
      expect(parsed[0].modifiedExports).toContain('added');
    });

    it('TC-T5-PRE-04: model evaluation filters out confidence < 0.70 while retaining >= 0.70', async () => {
      const tool = createPreflightDiffReviewTool({
        modelClient: {
          evaluateDiff: async () => ({
            findings: [
              {
                finding_id: 'low-conf-1',
                severity: 'P1',
                category: 'Testing',
                title: 'Speculative edge case',
                file_path: 'src/calc.ts',
                rationale: 'Uncertain finding',
                confidence: 0.55, // Should be dropped (< 0.70)
              },
              {
                finding_id: 'high-conf-1',
                severity: 'P1',
                category: 'Architecture',
                title: 'Definite unbounded buffer growth',
                file_path: 'src/calc.ts',
                rationale: 'Verified memory issue',
                confidence: 0.95, // Should be retained
              },
            ],
          }),
        },
      });

      const res = await tool.execute({
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.cleanCode,
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.findings).toHaveLength(1);
      expect(content.findings[0].finding_id).toBe('high-conf-1');
      expect(content.eligible_to_ship).toBe(false);
    });

    it('TC-T5-PRE-05: deduplication merges static and model findings on same file and line', async () => {
      // In DIFF_FIXTURES.sqlInjection, the dynamic SQL string concat is added at line 12
      const tool = createPreflightDiffReviewTool({
        modelClient: {
          evaluateDiff: async () => ({
            findings: [
              {
                finding_id: 'model-sqli-dup',
                severity: 'P0',
                category: 'Security',
                title: 'Potential SQL injection vulnerability via string concatenation',
                file_path: 'src/db/userQuery.ts',
                line: 12,
                rationale: 'SQL query constructed via string concatenation with dynamic parameter instead of parameterized query.',
                suggested_fix: 'Parameterized query with $1',
                confidence: 0.99,
              },
            ],
          }),
        },
      });

      const res = await tool.execute({
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.sqlInjection,
      });

      const content = JSON.parse((res as any).content[0].text);
      // Both static and model caught line 12 SQLi; deduplication merges them into 1 finding
      expect(content.findings).toHaveLength(1);
      expect(content.findings[0].suggested_fix).toMatch(/parameterized/i);
    });
  });

  // ===========================================================================
  // Suite 5: Fix Diff Generation White-Box Git Synthesis & Verification
  // ===========================================================================
  describe('Suite 5: Fix Diff Generation White-Box Git Synthesis & Verification', () => {
    it('TC-T5-FIX-01: validatePatchWithGitApply invokes real git binary validating syntax with git apply --check', () => {
      const orig = 'function add(a, b) {\n  return a + b;\n}\n';
      const patch = `--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,3 @@
 function add(a, b) {
-  return a + b;
+  return Number(a) + Number(b);
 }
`;
      const result = validatePatchWithGitApply(patch, 'src/math.ts', orig);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('TC-T5-FIX-02: invalid patch syntax fails git validation and safely falls back to static replacement', async () => {
      // 1. Direct validation unit test: malformed diff header fails git apply --check
      const malformedPatch = `--- a/src/math.ts
+++ b/src/math.ts
@@ invalid hunk header @@
-corrupt
+broken
`;
      const valResult = validatePatchWithGitApply(malformedPatch, 'src/math.ts', 'function add() {}\n');
      expect(valResult.valid).toBe(false);
      expect(valResult.error).toBeDefined();

      // 2. Integration test: model returning malformed non-JSON safely falls back to static replacement
      const tool = createGenerateFixDiffTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                run_id: 'run-101',
                payload: JSON.stringify({
                  findings: [
                    {
                      finding_id: 'find-bad-patch',
                      file_path: 'src/calc.ts',
                      line_start: 1,
                      line_end: 3,
                      originalCode: 'const x = 1;\nconst y = 2;\n',
                      suggested_fix: 'const x = 10;\nconst y = 20;\n',
                    },
                  ],
                }),
              },
            ],
          }),
        },
        modelClient: {
          complete: async () => ({
            // Model generates plain text commentary without valid JSON wrapper
            content: 'I cannot fix this finding because of architectural constraints.',
          }),
        },
        validatePatch: true,
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 55,
        finding_id: 'find-bad-patch',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content).toBeDefined();
      expect(content.file_path).toBe('src/calc.ts');
      // Falls back to static suggested_fix
      expect(content.replacement_lines).toContain('const x = 10;');
    });

    it('TC-T5-FIX-03: pure addition synthesis produces hunk header with 0 deletions @@ -L,0 +L,N @@', () => {
      const diff = synthesizeUnifiedDiff('src/constants.ts', 25, '', 'export const MAX = 100;\nexport const MIN = 1;\n');
      expect(diff).toContain('@@ -25,0 +25,2 @@');
      expect(diff).not.toContain('\n-');
      expect(diff).toContain('+export const MAX = 100;');
    });

    it('TC-T5-FIX-04: pure deletion synthesis produces hunk header with 0 additions @@ -L,N +L,0 @@', () => {
      const diff = synthesizeUnifiedDiff('src/legacy.ts', 40, 'const deadCode = true;\nconst unused = false;\n', '');
      expect(diff).toContain('@@ -40,2 +40,0 @@');
      expect(diff).toContain('-const deadCode = true;');
      // Diff body contains no added lines (only deletions)
      expect(diff).not.toMatch(/\n\+[^+]/);
    });

    it('TC-T5-FIX-05: code snippet resolution traverses fallback chain to codeSnippet field', async () => {
      const tool = createGenerateFixDiffTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                run_id: 'run-fallback',
                payload: JSON.stringify({
                  findings: [
                    {
                      id: 'find-fallback-chain',
                      file_path: 'src/buffer.ts',
                      line_start: 5,
                      line_end: 6,
                      // originalCode omitted, original_lines omitted, uses codeSnippet
                      codeSnippet: 'let buffer = [];\n',
                      suggested_fix: 'let buffer = new RingBuffer(100);\n',
                    },
                  ],
                }),
              },
            ],
          }),
        },
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 12,
        finding_id: 'find-fallback-chain',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.original_lines).toBe('let buffer = [];\n');
      expect(content.patch).toContain('let buffer = new RingBuffer(100);');
    });

    it('TC-T5-FIX-06: fetchFileLines exception is caught gracefully and falls back to empty string', async () => {
      const tool = createGenerateFixDiffTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                run_id: 'run-fetch-err',
                payload: JSON.stringify({
                  findings: [
                    {
                      id: 'find-fetch-err',
                      file_path: 'src/remote.ts',
                      line_start: 1,
                      line_end: 2,
                      suggested_fix: 'const fixed = true;\n',
                    },
                  ],
                }),
              },
            ],
          }),
        },
        fetchFileLines: async () => {
          throw new Error('Remote GitHub file fetch failed: HTTP 500');
        },
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 14,
        finding_id: 'find-fetch-err',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.original_lines).toBe('');
      expect(content.patch).toContain('+const fixed = true;');
    });
  });

  // ===========================================================================
  // Suite 6: Dispute Finding Quorum Adjudication & Ledger Blocker Math
  // ===========================================================================
  describe('Suite 6: Dispute Finding Quorum Adjudication & Ledger Blocker Math', () => {
    it('TC-T5-DIS-01: evaluateDisputeWithModel parses structured verdict, reasoning, and confidence', async () => {
      const mockClient: any = {
        complete: async () => ({
          content: JSON.stringify({
            verdict: 'overruled',
            reasoning: 'DeepSeek verified technical guard in lines 45-50 handles the concurrency hazard.',
            confidence: 0.94,
          }),
        }),
      };

      const result = await evaluateDisputeWithModel(
        mockClient,
        { title: 'Concurrency hazard', file_path: 'src/sync.ts' },
        'The mutex lock in parent coordinator guards this path'
      );

      expect(result.verdict).toBe('overruled');
      expect(result.confidence).toBe(0.94);
      expect(result.reasoning).toMatch(/concurrency hazard/i);
    });

    it('TC-T5-DIS-02: overruled finding triggers SSE notifyResourceUpdated, upheld does not', async () => {
      const notifySpy = vi.fn();

      // Seed database with a run and 1 finding
      env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 99,
        head_sha: '1'.repeat(40),
      });
      const run = env.db.runs[0];
      env.db.seedFinding({
        finding_id: 'f-overrule-test',
        run_id: run.run_id,
        severity: 'P1',
        title: 'Buffer overflow',
        file_path: 'src/buf.ts',
      });

      const tool = createDisputeFindingTool({
        queryableDatabase: env.db,
        adjudicateDispute: async (_f, arg) => {
          if (arg.includes('valid')) {
            return { verdict: 'overruled', reasoning: 'Valid rebuttal' };
          }
          return { verdict: 'upheld', reasoning: 'Dismissive rebuttal' };
        },
        notifyResourceUpdated: notifySpy,
      });

      // 1. Upheld dispute does not call notifyResourceUpdated
      await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 99,
        finding_id: 'f-overrule-test',
        counter_argument: 'whatever',
      });
      expect(notifySpy).not.toHaveBeenCalled();

      // 2. Overruled dispute calls notifyResourceUpdated twice (findings + runs)
      await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 99,
        finding_id: 'f-overrule-test',
        counter_argument: 'valid technical justification',
      });
      expect(notifySpy).toHaveBeenCalledTimes(2);
      expect(notifySpy).toHaveBeenCalledWith('review-yeti://findings/calltelemetry/cisco-cdr/99');
      expect(notifySpy).toHaveBeenCalledWith('review-yeti://runs/calltelemetry/cisco-cdr/99');
    });

    it('TC-T5-DIS-03: blocker count recalculation accurately handles mixed P0/P1/P2 and resolved states', async () => {
      env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 77,
        head_sha: '2'.repeat(40),
      });
      const run = env.db.runs[0];

      // Seed 4 findings:
      // 1: P0 open (blocker)
      // 2: P1 being disputed (blocker)
      // 3: P2 advisory (non-blocker)
      // 4: P1 already resolved (non-blocker)
      env.db.seedFinding({ finding_id: 'f-p0-open', run_id: run.run_id, severity: 'P0', title: 'P0 Blocker', file_path: 'a.ts' });
      env.db.seedFinding({ finding_id: 'f-p1-target', run_id: run.run_id, severity: 'P1', title: 'P1 Target', file_path: 'b.ts' });
      env.db.seedFinding({ finding_id: 'f-p2-adv', run_id: run.run_id, severity: 'P2', title: 'P2 Advisory', file_path: 'c.ts' });
      env.db.seedFinding({ finding_id: 'f-p1-resolved', run_id: run.run_id, severity: 'P1', title: 'P1 Resolved', file_path: 'd.ts', status: 'RESOLVED' });

      const tool = createDisputeFindingTool({
        queryableDatabase: env.db,
        adjudicateDispute: () => ({ verdict: 'overruled', reasoning: 'Accept technical proof' }),
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 77,
        finding_id: 'f-p1-target',
        counter_argument: 'Acceptable mitigation proof per ADR 0564',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.verdict).toBe('overruled');
      // Remaining blockers: only f-p0-open remains (1 blocker)
      expect(content.remaining_blockers).toBe(1);
    });

    it('TC-T5-DIS-04: model exception gracefully falls back to defaultAdjudicateFinding heuristics', async () => {
      const failingModel: any = {
        complete: async () => {
          throw new Error('Model rate limit reached (HTTP 429)');
        },
      };

      const result = await evaluateDisputeWithModel(
        failingModel,
        { title: 'Buffer unbounded', file_path: 'src/buf.ts' },
        'ignore this error'
      );

      // Dismissive rebuttal falls back to default heuristic which upholds it
      expect(result.verdict).toBe('upheld');
      expect(result.reasoning).toMatch(/Counter-argument lacks technical evidence/i);
    });

    it('TC-T5-DIS-05: database query executes updates on worker completion payload', async () => {
      const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT c.run_id')) {
          return {
            rows: [
              {
                run_id: 'run-db-test',
                execution_attempt: 1,
                payload: JSON.stringify({
                  findings: [{ id: 'find-to-overrule', severity: 'P1', title: 'Test Finding' }],
                }),
              },
            ],
          };
        }
        return { rows: [] };
      });

      const tool = createDisputeFindingTool({
        queryableDatabase: { query: mockQuery },
        adjudicateDispute: () => ({ verdict: 'overruled', reasoning: 'Accept' }),
      });

      await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 88,
        finding_id: 'find-to-overrule',
        counter_argument: 'Detailed technical mitigation description here',
      });

      // Verify UPDATE was executed on review_worker_completions
      const updateCall = mockQuery.mock.calls.find((call) => call[0].includes('UPDATE review_worker_completions'));
      expect(updateCall).toBeDefined();
      expect(updateCall![1][0]).toContain('"status":"OVERRULED"');
    });
  });

  // ===========================================================================
  // Suite 7: Explain Finding Scoping, Multi-Tenant Fail-Closed & Heuristics
  // ===========================================================================
  describe('Suite 7: Explain Finding Scoping, Multi-Tenant Fail-Closed & Heuristics', () => {
    it('TC-T5-EXP-01: unscoped query without owner/repo fails closed for unauthenticated caller', async () => {
      const tool = createExplainFindingTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                owner: 'secret-tenant',
                repo: 'secret-repo',
                payload: JSON.stringify({
                  personas: [{ findings: [{ id: 'f-secret', title: 'Secret' }] }],
                }),
              },
            ],
          }),
        },
      });

      // No context.caller supplied
      const res = await tool.execute({
        finding_id: 'f-secret',
        question: 'What is this finding?',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.explanation).toMatch(/was not found in the review ledger/i);
    });

    it('TC-T5-EXP-02: admin caller unscoped query searches across repository boundaries', async () => {
      const tool = createExplainFindingTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                owner: 'any-org',
                repo: 'any-repo',
                payload: JSON.stringify({
                  personas: [
                    { findings: [{ id: 'f-admin-find', title: 'Admin Accessible Finding', file_path: 'src/a.ts' }] },
                  ],
                }),
              },
            ],
          }),
        },
      });

      const res = await tool.execute(
        { finding_id: 'f-admin-find', question: 'Explain this finding' },
        {
          caller: {
            authType: 'static_token',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'admin-user',
            tokenDigest: 'digest',
          },
        }
      );

      const content = JSON.parse((res as any).content[0].text);
      expect(content.explanation).not.toMatch(/was not found/i);
      expect(content.explanation).toContain('Admin Accessible Finding');
    });

    it('TC-T5-EXP-03: heuristic evaluation accurately classifies informational questions as null', () => {
      const record: StoredFindingRecord = {
        finding_id: 'f1',
        title: 'Buffer issue',
        severity: 'P1',
        category: 'Architecture',
        file_path: 'src/buf.ts',
        line_start: 10,
        line_end: 15,
        violated_adrs: ['ADR 0564'],
        rationale: 'Unbounded memory allocation',
      };

      const res = evaluateWithHeuristics(record, 'What does this finding mean and why is it an issue?');
      expect(res.satisfiesRequirement).toBeNull();
      expect(res.citations).toEqual(['ADR 0564']);
    });

    it('TC-T5-EXP-04: heuristic evaluation classifies bypass proposals as satisfies_requirement: false', () => {
      const record: StoredFindingRecord = {
        finding_id: 'f2',
        title: 'Auth check missing',
        severity: 'P0',
        category: 'Security',
        file_path: 'src/auth.ts',
        line_start: 5,
        line_end: 10,
        violated_adrs: ['ADR 0242'],
        rationale: 'Missing token check',
      };

      const res = evaluateWithHeuristics(record, 'Can I just disable or bypass this check in development?');
      expect(res.satisfiesRequirement).toBe(false);
      expect(res.explanation).toMatch(/does not satisfy the requirements/i);
    });

    it('TC-T5-EXP-05: heuristic evaluation classifies compliant remediation as satisfies_requirement: true', () => {
      const record: StoredFindingRecord = {
        finding_id: 'f3',
        title: 'Cache growth',
        severity: 'P1',
        category: 'Architecture',
        file_path: 'src/cache.ts',
        line_start: 1,
        line_end: 5,
        violated_adrs: ['ADR 0564'],
        rationale: 'Cache map has no max capacity',
      };

      const res = evaluateWithHeuristics(record, 'What if I implement a bounded LRU cache with max-size 500?');
      expect(res.satisfiesRequirement).toBe(true);
      expect(res.explanation).toMatch(/satisfies the architectural and safety requirements/i);
    });

    it('TC-T5-EXP-06: supports model client with generate() method alongside complete()', async () => {
      const legacyModel: any = {
        generate: async (prompt: string) => {
          expect(prompt).toContain('Analyze the following code review finding');
          return JSON.stringify({
            explanation: 'Legacy generator explanation of finding.',
            satisfies_requirement: true,
            citations: ['ADR 0564'],
          });
        },
      };

      const tool = createExplainFindingTool({
        queryableDatabase: {
          query: async () => ({
            rows: [
              {
                payload: JSON.stringify({
                  personas: [
                    { findings: [{ id: 'f-legacy', title: 'Legacy Finding', file_path: 'a.ts' }] },
                  ],
                }),
              },
            ],
          }),
        },
        modelClient: legacyModel,
      });

      const res = await tool.execute(
        {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          finding_id: 'f-legacy',
          question: 'How to fix with bounded buffer?',
        },
        {
          caller: {
            authType: 'static_token',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'admin-tester',
            tokenDigest: 'digest',
          },
        }
      );

      const content = JSON.parse((res as any).content[0].text);
      expect(content.explanation).toBe('Legacy generator explanation of finding.');
      expect(content.satisfies_requirement).toBe(true);
    });
  });

  // ===========================================================================
  // Suite 8: Review Engine Selection (trigger_review & publishingReview)
  // ===========================================================================
  describe('Suite 8: Review Engine Selection Hardening', () => {
    it('TC-T5-ENG-01: TriggerReviewInputSchema validates review_engine enum and rejects invalid values', () => {
      // 1. Valid values
      expect(TriggerReviewInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 1,
        head_sha: 'a'.repeat(40),
        review_engine: 'composed',
      }).success).toBe(true);

      expect(TriggerReviewInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 1,
        head_sha: 'a'.repeat(40),
        review_engine: 'panel',
      }).success).toBe(true);

      // 2. Invalid enum values
      const invalidEnum = TriggerReviewInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 1,
        head_sha: 'a'.repeat(40),
        review_engine: 'invalid_engine',
      });
      expect(invalidEnum.success).toBe(false);

      // 3. Non-string types
      const invalidType = TriggerReviewInputSchema.safeParse({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 1,
        head_sha: 'a'.repeat(40),
        review_engine: 123,
      });
      expect(invalidType.success).toBe(false);
    });

    it('TC-T5-ENG-02: triggerReview propagates review_engine to resolveCandidate and prepared.config', async () => {
      const mockAdmission = vi.fn().mockResolvedValue({
        run: { runId: 'run_1234567890123456' },
      });
      const mockResolve = vi.fn().mockResolvedValue({
        identity: 'test-identity',
        prepared: {
          config: { default_max_turns: 10 },
          policy: {
            sources: [
              {
                repositoryId: 1001,
                repository: 'calltelemetry/cisco-cdr',
                sha: 'b'.repeat(40),
                path: 'policy/review.json',
                contentDigest: 'c'.repeat(64),
              },
            ],
            effectivePolicy: { central: {} },
            effectivePolicyDigest: 'd'.repeat(64),
            effectiveConfigDigest: 'e'.repeat(64),
          },
          transport: { model: 'test' },
          expectedPersonaIds: ['security'],
        },
      });

      const tool = createTriggerReviewTool({
        admissionRepository: { admit: mockAdmission },
        resolveGitHubPullRequest: async () => ({ headSha: 'b'.repeat(40), repositoryId: 1001 }),
        authoritativePublishing: {
          acceptNewRequests: true,
          repositoryIds: [1001],
          expectedAppId: 4385771,
          resolver: { resolve: mockResolve },
        } as any,
      });

      const res = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 12,
        head_sha: 'b'.repeat(40),
        review_engine: 'composed',
      });

      const content = JSON.parse((res as any).content[0].text);
      expect(content.dispatched).toBe(true);
      expect(content.message).toContain('engine: composed');

      // Verify admit called with reviewEngine
      expect(mockAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewEngine: 'composed',
        })
      );
    });

    it('TC-T5-ENG-03: resolveGitHubPullRequest headSha mismatch fails closed', async () => {
      const tool = createTriggerReviewTool({
        resolveGitHubPullRequest: async () => ({ headSha: 'c'.repeat(40) }),
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 15,
          head_sha: 'd'.repeat(40), // Mismatch
        })
      ).rejects.toThrow(/does not match current GitHub PR/i);
    });

    it('TC-T5-ENG-04: authoritative admission rejects unauthorized repository', async () => {
      const tool = createTriggerReviewTool({
        admissionRepository: { admit: vi.fn() },
        resolveGitHubPullRequest: async () => ({ headSha: 'e'.repeat(40), repositoryId: 9999 }),
        authoritativePublishing: {
          acceptNewRequests: true,
          repositoryIds: [1001], // 9999 not in allowlist
        } as any,
      });

      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 15,
          head_sha: 'e'.repeat(40),
        })
      ).rejects.toThrow(/outside authoritative admission/i);
    });

    it('TC-T5-ENG-05: active review conflict throws error with code 409', async () => {
      const tool = createTriggerReviewTool({
        queryableDatabase: {
          query: async () => ({
            rows: [{ run_id: 'run-active-1', status: 'running' }],
          }),
        },
      });

      try {
        await tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 20,
          head_sha: 'f'.repeat(40),
          force: false,
        });
        expect.fail('Expected conflict 409 error');
      } catch (err: any) {
        expect(err.code).toBe(409);
        expect(err.message).toMatch(/Conflict: Review attempt .* is currently running/i);
      }
    });

    it('TC-T5-ENG-06: resolveReviewEngine unit test verifies fail-inert to panel', () => {
      expect(resolveReviewEngine({ review_engine: 'composed' })).toBe('composed');
      expect(resolveReviewEngine({ review_engine: 'shadow' })).toBe('shadow');
      expect(resolveReviewEngine({ review_engine: 'panel' })).toBe('panel');
      expect(resolveReviewEngine({ review_engine: 'unknown' })).toBe('panel');
      expect(resolveReviewEngine({ review_engine: 123 })).toBe('panel');
      expect(resolveReviewEngine({})).toBe('panel');
      expect(resolveReviewEngine(null as any)).toBe('panel');
      expect(resolveReviewEngine(undefined as any)).toBe('panel');
    });

    it('TC-T5-ENG-07: runPublishingReviewWorker invokes composedReviewRunner when config resolves to composed', async () => {
      const composedRunner = vi.fn().mockResolvedValue({
        lanes: [{ persona: 'architect', status: 'pass', findings: [] }],
        turnsCount: 3,
        promptTokens: 100,
        completionTokens: 50,
      });
      const panelRunner = vi.fn().mockResolvedValue({
        lanes: [{ persona: 'security', status: 'pass', findings: [] }],
      });
      const sourceLoader = vi.fn().mockResolvedValue({
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n+const x = 1;\n',
      });

      const workerEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        REVIEW_PUBLICATION_MODE: 'app-gate',
        REVIEW_YETI_POLICY_JSON: JSON.stringify({
          review_yeti: {
            personas: 'security',
            budget: { max_investigation_turns: 5 },
            review_engine: 'composed',
          },
        }),
        REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
        REVIEW_REPO: 'calltelemetry/cisco-cdr',
        REVIEW_REPOSITORY_ID: '1001',
        REVIEW_POLICY_DIGEST: 'c'.repeat(64),
        REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
        REVIEW_EXECUTION_ATTEMPT: '1',
        REVIEW_PR_NUMBER: '100',
        REVIEW_HEAD_SHA: 'a'.repeat(40),
        REVIEW_BASE_SHA: 'b'.repeat(40),
        REVIEW_MODEL: 'deepseek/deepseek-v4-flash-0731',
        OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
        OPENAI_API_KEY: 'vk-test',
        GH_TOKEN: 'ghs_test',
        REVIEW_CHECK_ID: '9999',
      };

      const deps: PublishingReviewDeps = {
        composedReviewRunner: composedRunner,
        panelRunner: panelRunner,
        sourceLoader: sourceLoader,
        visibilityLookup: async () => 'PUBLIC',
        checkClient: {
          createCheck: vi.fn().mockResolvedValue(9999),
          updateCheck: vi.fn().mockResolvedValue(undefined),
          completeCheck: vi.fn().mockResolvedValue(undefined),
        },
      };

      const receipt = await runPublishingReviewWorker(workerEnv, deps);
      expect(receipt).toBeDefined();
      expect(composedRunner).toHaveBeenCalled();
      expect(panelRunner).not.toHaveBeenCalled();
    });
  });
});
