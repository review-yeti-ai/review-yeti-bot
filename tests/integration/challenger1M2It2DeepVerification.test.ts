import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
} from '../../src/mcp/server/remoteMcpRouter';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';
import { createPreflightDiffReviewTool } from '../../src/mcp/server/tools/preflightDiffReview';
import { createWatchReviewProgressTool } from '../../src/mcp/server/tools/watchReviewProgress';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { JSONRPC_ERRORS, MCP_ERRORS } from '../../src/mcp/server/mcpTypes';
import {
  type McpAuthenticator,
  type McpAuthenticatedCaller,
  McpAuthError,
} from '../../src/mcp/server/mcpAuthenticator';

describe('Milestone 2 Iteration 2: Deep Empirical Adversarial Verification Suite', () => {
  let app: express.Express;
  let router: RemoteMcpRouter;
  let mockDb: any;

  const validTokenTenantA = 'token-tenant-a';
  const tenantAOwner = 'tenant-a-org';
  const tenantARepo = 'tenant-a-service';

  const validTokenAdmin = 'token-admin';

  beforeEach(() => {
    mockDb = {
      query: vi.fn(async (_sql: string, _params?: any[]) => {
        return { rows: [] };
      }),
    };

    const authenticator: McpAuthenticator = {
      authenticate: vi.fn(async (req: Request) => {
        const header = req.header('authorization') || '';
        if (header === `Bearer ${validTokenTenantA}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest_tenant_a',
            isAdmin: false,
            allowedRepositories: new Set([
              `${tenantAOwner}/${tenantARepo}`,
              'calltelemetry/cisco-cdr',
            ]),
            callerId: 'tenant-a-agent',
          } satisfies McpAuthenticatedCaller;
        }
        if (header === `Bearer ${validTokenAdmin}`) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest_admin',
            isAdmin: true,
            allowedRepositories: null,
            callerId: 'admin-agent',
          } satisfies McpAuthenticatedCaller;
        }
        throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
      }) as any,
      authenticateToken: vi.fn(async (token: string) => {
        if (token === validTokenTenantA) {
          return {
            authType: 'static_token',
            tokenDigest: 'digest_tenant_a',
            isAdmin: false,
            allowedRepositories: new Set([
              `${tenantAOwner}/${tenantARepo}`,
              'calltelemetry/cisco-cdr',
            ]),
            callerId: 'tenant-a-agent',
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

  async function invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    token = validTokenTenantA,
    id = 1
  ) {
    const res = await request(app)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
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

  // =========================================================================
  // 1. explain_finding: Nonexistent IDs, No Hardcoded Payloads, Tenancy & RBAC
  // =========================================================================
  describe('1. explain_finding Tool Empirical Verification', () => {
    it('never returns hardcoded CWE payloads for old legacy IDs when DB has no matching record', async () => {
      // Legacy hardcoded IDs that were previously intercepted:
      const legacyIds = [
        '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        '02BRZ3NDEKTSV4RRFFQ69G5FAW',
      ];

      for (const findingId of legacyIds) {
        mockDb.query.mockResolvedValueOnce({ rows: [] });

        const res = await invokeTool('explain_finding', {
          finding_id: findingId,
          question: 'What is this finding and how do I fix it?',
          owner: tenantAOwner,
          repo: tenantARepo,
        });

        expect(res.status).toBe(200);
        expect(res.body.result).toBeDefined();
        const content = JSON.parse(res.body.result.content[0].text);

        // MUST be found: false / informative not found, NOT hardcoded CWE-89 or CWE-79
        expect(content.explanation).toContain(`Finding '${findingId}' was not found in the review ledger`);
        expect(content.explanation).not.toContain('CWE-89');
        expect(content.explanation).not.toContain('CWE-79');
        expect(content.satisfies_requirement).toBeNull();
        expect(content.citations).toEqual([]);
      }
    });

    it('returns graceful not found for completely nonexistent random finding IDs', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [] });

      const randomId = 'finding-random-id-' + Math.random().toString(36).substring(7);
      const res = await invokeTool('explain_finding', {
        finding_id: randomId,
        question: 'Explain this finding',
        owner: tenantAOwner,
        repo: tenantARepo,
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
      const content = JSON.parse(res.body.result.content[0].text);
      expect(content.explanation).toContain(`Finding '${randomId}' was not found in the review ledger`);
      expect(content.citations).toEqual([]);
    });

    it('enforces RBAC 403 when caller specifies an unauthorized repository in explain_finding', async () => {
      const res = await invokeTool('explain_finding', {
        finding_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        question: 'How to fix?',
        owner: 'unauthorized-org',
        repo: 'unauthorized-repo',
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toContain('Forbidden: Access to repository unauthorized-org/unauthorized-repo denied');
    });

    it('filters out findings belonging to other tenants when owner/repo omitted in query', async () => {
      // DB has findings belonging to tenant-b, which tenant-a caller is NOT allowed to see
      const otherTenantPayload = {
        result: {
          personas: [
            {
              findings: [
                {
                  finding_id: 'secret-finding-tenant-b',
                  title: 'Secret leak in tenant B',
                  severity: 'P0',
                  path: 'src/secret.ts',
                  violated_adrs: ['ADR 0100'],
                  rationale: 'Sensitive customer data exposed',
                },
              ],
            },
          ],
        },
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            payload: JSON.stringify(otherTenantPayload),
            owner: 'tenant-b-org',
            repo: 'tenant-b-service',
            run_id: 'run-b-1',
          },
        ],
      });

      // Caller tenant-a searches without specifying owner/repo
      const res = await invokeTool('explain_finding', {
        finding_id: 'secret-finding-tenant-b',
        question: 'What is this?',
      });

      expect(res.status).toBe(200);
      const content = JSON.parse(res.body.result.content[0].text);
      // Because tenant-a is not allowed on tenant-b-org/tenant-b-service, row is filtered out!
      expect(content.explanation).toContain("Finding 'secret-finding-tenant-b' was not found in the review ledger");
      expect(content.citations).toEqual([]);
    });

    it('correctly explains authorized finding from DB and validates compliant vs non-compliant proposals', async () => {
      const findingPayload = {
        result: {
          personas: [
            {
              findings: [
                {
                  finding_id: 'finding-tenant-a-1',
                  title: 'Unbounded cache in consumer',
                  severity: 'P1',
                  path: 'src/cache.ts',
                  line_start: 10,
                  line_end: 20,
                  violated_adrs: ['ADR 0564'],
                  rationale: 'Cache can cause memory leak without bounds.',
                  suggested_fix: 'Use an LRU cache with capacity limit.',
                },
              ],
            },
          ],
        },
      };

      // 1. Test Compliant proposal
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            payload: JSON.stringify(findingPayload),
            owner: tenantAOwner,
            repo: tenantARepo,
            run_id: 'run-a-1',
          },
        ],
      });

      const resCompliant = await invokeTool('explain_finding', {
        finding_id: 'finding-tenant-a-1',
        question: 'What if I implement a bounded LRU cache with a capacity of 500 items?',
        owner: tenantAOwner,
        repo: tenantARepo,
      });

      const dataCompliant = JSON.parse(resCompliant.body.result.content[0].text);
      expect(dataCompliant.satisfies_requirement).toBe(true);
      expect(dataCompliant.citations).toContain('ADR 0564');
      expect(dataCompliant.explanation).toContain('satisfies the architectural');

      // 2. Test Non-compliant proposal
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            payload: JSON.stringify(findingPayload),
            owner: tenantAOwner,
            repo: tenantARepo,
            run_id: 'run-a-1',
          },
        ],
      });

      const resNonCompliant = await invokeTool('explain_finding', {
        finding_id: 'finding-tenant-a-1',
        question: 'Can I just disable the cache check and suppress the warning?',
        owner: tenantAOwner,
        repo: tenantARepo,
      });

      const dataNonCompliant = JSON.parse(resNonCompliant.body.result.content[0].text);
      expect(dataNonCompliant.satisfies_requirement).toBe(false);
      expect(dataNonCompliant.explanation).toContain('does not satisfy');
    });
  });

  // =========================================================================
  // 2. preflight_diff_review: Command Injection Variations & Benign Controls
  // =========================================================================
  describe('2. preflight_diff_review Command Injection & False-Positive Precision', () => {
    const tool = createPreflightDiffReviewTool();

    it('detects command injection with prefix string concatenation', async () => {
      const diff = `diff --git a/src/runner.ts b/src/runner.ts
--- a/src/runner.ts
+++ b/src/runner.ts
@@ -1,2 +1,3 @@
+const { exec } = require('child_process');
+exec("ping -c 1 " + hostName);
`;
      const res = await tool.execute({ repo: 'calltelemetry/cisco-cdr', diff });
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings.some((f: any) => f.title.includes('Command Injection'))).toBe(true);
      expect(data.findings[0].severity).toBe('P0');
    });

    it('detects command injection with variable concatenation before/after', async () => {
      const diff = `diff --git a/src/runner.ts b/src/runner.ts
--- a/src/runner.ts
+++ b/src/runner.ts
@@ -1,2 +1,3 @@
+const { execSync } = require('child_process');
+execSync(cmdPrefix + " -v");
`;
      const res = await tool.execute({ repo: 'calltelemetry/cisco-cdr', diff });
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings.some((f: any) => f.title.includes('Command Injection'))).toBe(true);
    });

    it('detects command injection with template string interpolation', async () => {
      const diff = `diff --git a/src/deploy.ts b/src/deploy.ts
--- a/src/deploy.ts
+++ b/src/deploy.ts
@@ -1,2 +1,3 @@
+import { exec } from 'child_process';
+exec(\`git checkout \${branchName}\`);
`;
      const res = await tool.execute({ repo: 'calltelemetry/cisco-cdr', diff });
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings.some((f: any) => f.title.includes('Command Injection'))).toBe(true);
    });

    it('detects command injection with multiline diffs containing spawn and user input', async () => {
      const diff = `diff --git a/src/shell.ts b/src/shell.ts
--- a/src/shell.ts
+++ b/src/shell.ts
@@ -5,3 +5,6 @@
 export function runUserScript(req: any) {
+  const { spawn } = require('child_process');
+  const proc = spawn(req.body.scriptPath);
+  return proc;
 }
`;
      const res = await tool.execute({ repo: 'calltelemetry/cisco-cdr', diff });
      const data = JSON.parse((res.content[0] as any).text);

      expect(data.eligible_to_ship).toBe(false);
      expect(data.findings.some((f: any) => f.title.includes('Command Injection'))).toBe(true);
    });

    it('does NOT false positive on benign static commands with constant string arguments', async () => {
      const benignDiff = `diff --git a/src/status.ts b/src/status.ts
--- a/src/status.ts
+++ b/src/status.ts
@@ -1,2 +1,5 @@
+const { exec, execSync, spawn } = require('child_process');
+exec("git status");
+execSync("npm test");
+spawn("node", ["server.js"]);
`;
      const res = await tool.execute({ repo: 'calltelemetry/cisco-cdr', diff: benignDiff });
      const data = JSON.parse((res.content[0] as any).text);

      // Should not flag any Command Injection findings on constant strings without variables/interpolation
      const cmdiFindings = data.findings.filter((f: any) => f.title.includes('Command Injection'));
      expect(cmdiFindings).toHaveLength(0);
      expect(data.eligible_to_ship).toBe(true);
    });
  });

  // =========================================================================
  // 3. remoteMcpRouter RBAC Resolution: Coordinate Parsing & Error Semantics
  // =========================================================================
  describe('3. remoteMcpRouter RBAC Resolution & Coordinate Parsing', () => {
    it('correctly resolves composite repo: "owner/repo" format for authorized repository', async () => {
      const res = await invokeTool('preflight_diff_review', {
        repo: `${tenantAOwner}/${tenantARepo}`,
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# A\n+# B',
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('blocks composite repo: "owner/repo" with HTTP 403 / -32003 when unauthorized', async () => {
      const res = await invokeTool('preflight_diff_review', {
        repo: 'unauthorized-org/unauthorized-repo',
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# A\n+# B',
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
      expect(res.body.error.message).toContain('Forbidden: Access to repository unauthorized-org/unauthorized-repo denied');
    });

    it('infers owner when owner omitted but caller has unique match in allowedRepositories', async () => {
      // Caller has 'tenant-a-org/tenant-a-service' and 'calltelemetry/cisco-cdr' in allowedRepositories
      // If repo: 'cisco-cdr' is given without owner, router infers owner: 'calltelemetry' and allows access
      const res = await invokeTool('preflight_diff_review', {
        repo: 'cisco-cdr',
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# A\n+# B',
      });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    });

    it('blocks with HTTP 403 when repo is missing owner and cannot be resolved in allowedRepositories', async () => {
      const res = await invokeTool('preflight_diff_review', {
        repo: 'unknown-foreign-repo',
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# A\n+# B',
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(MCP_ERRORS.FORBIDDEN);
    });

    it('bypasses early RBAC on empty string repo: "" and rejects via schema validation with JSON-RPC -32602 (HTTP 200)', async () => {
      const res = await invokeTool('preflight_diff_review', {
        repo: '',
        diff: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# A\n+# B',
      });

      // Must be standard JSON-RPC schema error (-32602), NOT RBAC 403
      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('repo identifier is required');
    });

    it('bypasses early RBAC on empty string owner: "" and rejects via schema validation with JSON-RPC -32602 (HTTP 200)', async () => {
      const res = await invokeTool('get_review_status', {
        owner: '',
        repo: tenantARepo,
        pull_number: 1,
      });

      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
      expect(res.body.error.message).toContain('owner must not be empty');
    });
  });

  // =========================================================================
  // 4. Strict Fail-Closed Semantics: watchReviewProgress & getReviewStatus
  // =========================================================================
  describe('4. Strict Fail-Closed Semantics without Collaborators', () => {
    it('watch_review_progress strictly throws when subscribeProgress collaborator is missing', async () => {
      const tool = createWatchReviewProgressTool({});
      await expect(
        tool.execute({
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          pull_number: 10,
        })
      ).rejects.toThrow('JetStream subscription service unavailable: subscribeProgress dependency is required to watch review progress');
    });

    it('get_review_status returns found: false and Database unavailable message when db is missing (never fake SHIP)', async () => {
      const tool = createGetReviewStatusTool();
      const result = await tool.execute({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 10,
      });

      const data = JSON.parse((result.content[0] as any).text);
      expect(data.found).toBe(false);
      expect(data.verdict).toBe('PENDING');
      expect(data.attempt_id).toBeNull();
      expect(data.check_run).toBeNull();
      expect(data.active_worker).toBeNull();
      expect(data.phase).toBe('queued');
      expect(data.message).toBe('Database service is unavailable');
    });
  });
});
