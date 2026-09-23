/**
 * Opaque-Box E2E Test Harness for Review Yeti Bidirectional MCP & DeepSeek Integration
 *
 * Provides spec-compliant test doubles for:
 * 1. DeepSeek inference harness (deepseek/deepseek-v4-flash-0731 via OpenRouter)
 * 2. Bifrost MCP Gateway (ct-mcp: ct-impact, ct-knowledge, blocker-quorum)
 * 3. PostgreSQL review ledger (review_runs, review_worker_completions, artifacts)
 * 4. Express remote MCP router with Bearer auth, RBAC, and rate limiting
 */

import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import {
  createRemoteMcpRouter,
  type RemoteMcpRouter,
  type McpToolRegistry,
  DefaultMcpToolRegistry,
} from '../../../../src/mcp/server/remoteMcpRouter';
import {
  type McpAuthenticatedCaller,
  type McpAuthenticator,
  McpAuthError,
} from '../../../../src/mcp/server/mcpAuthenticator';
import {
  createPreflightDiffReviewTool,
  createGenerateFixDiffTool,
  createDisputeFindingTool,
  createExplainFindingTool,
  createTriggerReviewTool,
  createGetReviewStatusTool,
  createGetReviewFindingsTool,
} from '../../../../src/mcp/server/tools';
import { SlidingWindowRateLimiter } from '../../../../src/mcp/server/mcpRateLimiter';
import { MCP_ERRORS } from '../../../../src/mcp/server/mcpTypes';

export { MCP_ERRORS };

export const VALID_E2E_TOKEN = 'yeti_e2e_valid_token_secret_12345';
export const ADMIN_E2E_TOKEN = 'yeti_e2e_admin_token_secret_99999';

// =============================================================================
// Diff Fixtures
// =============================================================================

export const DIFF_FIXTURES = {
  safeMarkdown: `diff --git a/docs/architecture.md b/docs/architecture.md
index 1111111..2222222 100644
--- a/docs/architecture.md
+++ b/docs/architecture.md
@@ -1,3 +1,5 @@
 # System Architecture
+This document outlines the high-level architecture.
+All components adhere to ADR 0564.
`,

  cleanCode: `diff --git a/src/math/calculator.ts b/src/math/calculator.ts
index 2222222..3333333 100644
--- a/src/math/calculator.ts
+++ b/src/math/calculator.ts
@@ -10,6 +10,10 @@ export function add(a: number, b: number): number {
   return a + b;
 }
+
 export function multiply(a: number, b: number): number {
+  return a * b;
+}
`,

  hardcodedSecret: `diff --git a/src/auth/client.ts b/src/auth/client.ts
index 3333333..4444444 100644
--- a/src/auth/client.ts
+++ b/src/auth/client.ts
@@ -5,4 +5,6 @@ export class ApiClient {
   constructor() {
+    const apiKey = "ghp_123456789012345678901234567890123456";
+    this.token = apiKey;
   }
`,

  sqlInjection: `diff --git a/src/db/userQuery.ts b/src/db/userQuery.ts
index 4444444..5555555 100644
--- a/src/db/userQuery.ts
+++ b/src/db/userQuery.ts
@@ -12,4 +12,6 @@ export async function findUserByName(name: string) {
-  return db.query('SELECT * FROM users WHERE name = $1', [name]);
+  const query = "SELECT * FROM users WHERE name = " + req.name;
   return db.query(query);
 }
`,

  commandInjection: `diff --git a/src/utils/execHelper.ts b/src/utils/execHelper.ts
index 5555555..6666666 100644
--- a/src/utils/execHelper.ts
+++ b/src/utils/execHelper.ts
@@ -8,4 +8,6 @@ export function runCommand(userInput: string) {
+  const { execSync } = require('child_process');
+  execSync("echo " + userInput);
 }
`,

  multiFileRefactor: `diff --git a/src/billing/service.ts b/src/billing/service.ts
index 1000000..2000000 100644
--- a/src/billing/service.ts
+++ b/src/billing/service.ts
@@ -20,6 +20,12 @@ export class BillingService {
+  public computeMonthlyTotal(accountId: string, usage: number): number {
+    const rate = 0.05;
+    return usage * rate;
+  }
diff --git a/src/billing/types.ts b/src/billing/types.ts
index 3000000..4000000 100644
--- a/src/billing/types.ts
+++ b/src/billing/types.ts
@@ -5,4 +5,8 @@ export interface Invoice {
+  accountId: string;
+  amount: number;
+  currency: string;
+}
`,

  malformedDiff: `This is a completely invalid git diff payload without git diff headers or valid hunks.
Random content here.
@@ invalid hunk @@
`,
};

// =============================================================================
// Mock In-Memory Database
// =============================================================================

export interface StoredRun {
  run_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  status: string;
  attempt: number;
  decision?: any;
  created_at?: string;
  review_engine?: 'composed' | 'panel';
}

export interface StoredFinding {
  finding_id: string;
  run_id: string;
  severity: 'P0' | 'P1' | 'P2';
  category: string;
  title: string;
  file_path: string;
  line_start: number;
  line_end: number;
  violated_adrs: string[];
  rationale: string;
  suggested_fix: string;
  status: 'OPEN' | 'DISPUTED' | 'OVERRULED' | 'RESOLVED';
  originalCode?: string;
  replacementCode?: string;
}

export class MockDatabase {
  public runs: StoredRun[] = [];
  public findings: StoredFinding[] = [];

  public reset(): void {
    this.runs = [];
    this.findings = [];
  }

  public seedRun(run: Partial<StoredRun> & { owner: string; repo: string; pr_number: number; head_sha: string }): StoredRun {
    const fullRun: StoredRun = {
      run_id: run.run_id || `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      owner: run.owner,
      repo: run.repo,
      pr_number: run.pr_number,
      head_sha: run.head_sha,
      status: run.status || 'succeeded',
      attempt: run.attempt || 1,
      decision: run.decision || { verdict: 'SHIP' },
      created_at: run.created_at || new Date().toISOString(),
      review_engine: run.review_engine || 'panel',
    };
    this.runs.push(fullRun);
    return fullRun;
  }

  public seedFinding(finding: Partial<StoredFinding> & { run_id: string; file_path: string; title: string }): StoredFinding {
    const fullFinding: StoredFinding = {
      finding_id: finding.finding_id || `finding_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      run_id: finding.run_id,
      severity: finding.severity || 'P1',
      category: finding.category || 'Architecture',
      title: finding.title,
      file_path: finding.file_path,
      line_start: finding.line_start || 10,
      line_end: finding.line_end || 15,
      violated_adrs: finding.violated_adrs || ['ADR 0564'],
      rationale: finding.rationale || 'Finding rationale description',
      suggested_fix: finding.suggested_fix || 'Recommended fix implementation',
      status: finding.status || 'OPEN',
      originalCode: finding.originalCode,
      replacementCode: finding.replacementCode,
    };
    this.findings.push(fullFinding);
    return fullFinding;
  }

  public async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    const lower = sql.toLowerCase();

    // Helper to format finding payloads uniquely (under personas to avoid duplicates in candidateFindings)
    const formatFindingsPayload = (runFindings: StoredFinding[]) => {
      const findingList = runFindings.map((f) => ({
        finding_id: f.finding_id,
        id: f.finding_id,
        severity: f.severity,
        category: f.category,
        title: f.title,
        file_path: f.file_path,
        path: f.file_path,
        line_start: f.line_start,
        line_end: f.line_end,
        startLine: f.line_start,
        line: f.line_end,
        violated_adrs: f.violated_adrs,
        adrs: f.violated_adrs,
        rationale: f.rationale,
        body: f.rationale,
        suggested_fix: f.suggested_fix,
        suggestion: f.suggested_fix,
        originalCode: f.originalCode,
        replacementCode: f.replacementCode,
        status: f.status,
      }));

      return JSON.stringify({
        personas: [
          {
            id: 'security',
            findings: findingList,
          },
        ],
      });
    };

    // 1. Query review_runs by owner, repo, pr_number
    if (lower.includes('from review_runs') && lower.includes('owner = $1') && lower.includes('repo = $2') && lower.includes('pr_number = $3')) {
      const owner = String(params[0]);
      const repo = String(params[1]);
      const prNumber = Number(params[2]);

      const matchedRuns = this.runs.filter(
        (r) => r.owner.toLowerCase() === owner.toLowerCase() &&
               r.repo.toLowerCase() === repo.toLowerCase() &&
               r.pr_number === prNumber
      );

      // Check for worker completions join
      if (lower.includes('review_worker_completions') || lower.includes('review_run_artifacts')) {
        const rows = matchedRuns.map((r) => {
          const runFindings = this.findings.filter((f) => f.run_id === r.run_id);
          return {
            run_id: r.run_id,
            owner: r.owner,
            repo: r.repo,
            head_sha: r.head_sha,
            payload: formatFindingsPayload(runFindings),
          };
        });
        return { rows };
      }

      const rows = matchedRuns.map((r) => ({
        run_id: r.run_id,
        owner: r.owner,
        repo: r.repo,
        pr_number: r.pr_number,
        head_sha: r.head_sha,
        status: r.status,
        run_status: r.status,
        run_stage: 'persona',
        attempt: r.attempt,
        decision: JSON.stringify(r.decision),
        created_at: r.created_at,
        review_engine: r.review_engine,
      }));
      return { rows };
    }

    // 2. Query review_runs by owner, repo only
    if (lower.includes('from review_runs') && lower.includes('owner = $1') && lower.includes('repo = $2')) {
      const owner = String(params[0]);
      const repo = String(params[1]);

      const matchedRuns = this.runs.filter(
        (r) => r.owner.toLowerCase() === owner.toLowerCase() &&
               r.repo.toLowerCase() === repo.toLowerCase()
      );

      if (lower.includes('review_worker_completions')) {
        const rows = matchedRuns.map((r) => {
          const runFindings = this.findings.filter((f) => f.run_id === r.run_id);
          return {
            run_id: r.run_id,
            owner: r.owner,
            repo: r.repo,
            head_sha: r.head_sha,
            payload: formatFindingsPayload(runFindings),
          };
        });
        return { rows };
      }

      return { rows: matchedRuns };
    }

    return { rows: [] };
  }
}

// =============================================================================
// Mock DeepSeek Inference Harness
// =============================================================================

export interface MockDeepSeekOptions {
  latencyMs?: number;
  shouldTimeout?: boolean;
  shouldError?: boolean;
  findingsToReturn?: any[];
  disputeDecision?: { verdict: 'upheld' | 'overruled'; reasoning: string };
  explanationToReturn?: string;
}

export class MockDeepSeekHarness {
  public options: MockDeepSeekOptions;
  public evaluateDiffCalls: Array<{ prompt: string; signal?: AbortSignal }> = [];
  public disputeCalls: Array<{ finding: any; counterArgument: string }> = [];
  public explainCalls: Array<{ prompt: string }> = [];

  constructor(options: MockDeepSeekOptions = {}) {
    this.options = options;
  }

  public async evaluateDiff(prompt: string, signal?: AbortSignal): Promise<{ findings: any[] }> {
    this.evaluateDiffCalls.push({ prompt, signal });

    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    if (this.options.shouldTimeout) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('DeepSeek timeout (operation timed out after deadline)');
    }

    if (this.options.shouldError) {
      throw new Error('DeepSeek API connection error (HTTP 502)');
    }

    if (this.options.latencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    return {
      findings: this.options.findingsToReturn || [
        {
          finding_id: 'deepseek-p1-001',
          severity: 'P1',
          category: 'Architecture',
          title: 'Unbounded memory buffer allocation without limit',
          file_path: 'src/billing/service.ts',
          line: 22,
          rationale: 'DeepSeek Flash evaluated diff: memory growth could lead to node OOM.',
          suggested_fix: 'Implement bounded ring buffer with maxCapacity.',
        },
      ],
    };
  }

  public async adjudicateDispute(finding: any, counterArgument: string): Promise<{ verdict: 'upheld' | 'overruled'; reasoning: string }> {
    this.disputeCalls.push({ finding, counterArgument });

    if (this.options.disputeDecision) {
      return this.options.disputeDecision;
    }

    const trimmed = counterArgument.trim();
    if (trimmed.length < 20 || /^(ignore|whatever|not a bug|skip|wont fix)/i.test(trimmed)) {
      return {
        verdict: 'upheld',
        reasoning: `DeepSeek adjudicator upheld finding '${finding?.title}': Counter-argument lacks technical evidence.`,
      };
    }

    return {
      verdict: 'overruled',
      reasoning: `DeepSeek adjudicator accepted counter-argument: Technical mitigation verified in architectural context.`,
    };
  }

  public async generate(prompt: string): Promise<string> {
    this.explainCalls.push({ prompt });
    return this.options.explanationToReturn ||
      'DeepSeek Root-Cause Analysis: The finding violates architectural ADR 0564 regarding resource bounds.';
  }
}

// =============================================================================
// Mock Bifrost Fleet Gateway (ct-mcp)
// =============================================================================

export interface FleetToolCall {
  tool: string;
  params: Record<string, any>;
  receivedAt: number;
}

export class MockBifrostGateway {
  public toolCalls: FleetToolCall[] = [];
  public isOnline: boolean = true;
  public latencyMs: number = 0;
  public shouldTimeout: boolean = false;

  public listTools(): Array<{ name: string; description: string; inputSchema: any }> {
    return [
      {
        name: 'ct_impact',
        description: 'Cross-repository AST blast radius analysis and mesh queries',
        inputSchema: { type: 'object', properties: { target_file: { type: 'string' } } },
      },
      {
        name: 'ct_mesh_query',
        description: 'AST dependency graph query',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'ct_mesh_stats',
        description: 'AST mesh health statistics',
        inputSchema: { type: 'object' },
      },
      {
        name: 'knowledge_search',
        description: 'Governed Architecture Decision Records (ADRs) and runbooks',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'knowledge_get',
        description: 'Fetch specific ADR by identifier',
        inputSchema: { type: 'object', properties: { adr_id: { type: 'string' } } },
      },
      {
        name: 'advise_blocker',
        description: 'Active policy blockers and blocker-quorum advisory',
        inputSchema: { type: 'object', properties: { repository: { type: 'string' } } },
      },
      {
        name: 'health',
        description: 'Blocker quorum health check',
        inputSchema: { type: 'object' },
      },
    ];
  }

  public async executeTool(toolName: string, params: Record<string, any> = {}): Promise<{ success: boolean; output: any; error?: string }> {
    this.toolCalls.push({ tool: toolName, params, receivedAt: Date.now() });

    if (!this.isOnline) {
      return { success: false, output: null, error: 'Bifrost gateway connection refused (ECONNREFUSED)' };
    }

    if (this.shouldTimeout) {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      return { success: false, output: null, error: 'Bifrost tool call timed out after 15000ms' };
    }

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    // Prohibited mutating tools
    if (['memory_record', 'memory_supersede', 'write_file', 'modify_policy'].includes(toolName)) {
      return {
        success: false,
        output: null,
        error: `Permission Denied: Mutating tool '${toolName}' is prohibited in reviewer read-only context.`,
      };
    }

    switch (toolName) {
      case 'ct_impact':
      case 'ct_mesh_query':
        return {
          success: true,
          output: {
            blast_radius: 'MEDIUM',
            affected_repos: ['calltelemetry/cisco-cdr', 'calltelemetry/ct-release'],
            transitive_callers: 8,
            cross_repo_contracts_impacted: 1,
            summary: `AST mesh query for '${params.target_file || params.query || 'service'}' identified 8 callers across 2 repositories.`,
          },
        };
      case 'ct_mesh_stats':
        return {
          success: true,
          output: { nodes: 1420, edges: 5890, cycle_count: 0, status: 'HEALTHY' },
        };
      case 'knowledge_search':
      case 'knowledge_get':
        return {
          success: true,
          output: {
            adrs: [
              {
                id: 'ADR 0564',
                title: 'Bounded Memory Allocation and Ring Buffer Policies',
                status: 'ACCEPTED',
                summary: 'All stateful in-memory event caches and streaming buffers must specify hard capacity bounds.',
              },
              {
                id: 'ADR 0242',
                title: 'Parameterization of Dynamic Database Queries',
                status: 'ACCEPTED',
                summary: 'String concatenation in SQL queries is strictly prohibited.',
              },
            ],
          },
        };
      case 'advise_blocker':
        return {
          success: true,
          output: {
            active_blockers: 0,
            blockers: [],
            quorum_state: 'CONSENSUS_REACHED',
            advisory: 'No active blockers detected. Pull request is eligible for gate clearance.',
          },
        };
      case 'health':
        return {
          success: true,
          output: { status: 'OK', cluster: 'doks-nyc1', timestamp: new Date().toISOString() },
        };
      default:
        return {
          success: false,
          output: null,
          error: `Unknown Bifrost tool: ${toolName}`,
        };
    }
  }
}

// =============================================================================
// Test Environment Builder
// =============================================================================

export interface E2eTestEnvironment {
  app: Express;
  db: MockDatabase;
  deepSeek: MockDeepSeekHarness;
  bifrost: MockBifrostGateway;
  router: RemoteMcpRouter;
  rpcCall: (method: string, params?: Record<string, any>, token?: string) => Promise<request.Response>;
  callTool: (toolName: string, args: Record<string, any>, token?: string) => Promise<{ result?: any; error?: any; status: number }>;
}

export function buildE2eTestEnvironment(customOptions: {
  deepSeekOptions?: MockDeepSeekOptions;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  allowedRepos?: string[];
} = {}): E2eTestEnvironment {
  const db = new MockDatabase();
  const deepSeek = new MockDeepSeekHarness(customOptions.deepSeekOptions);
  const bifrost = new MockBifrostGateway();

  const allowedRepos = new Set(
    (customOptions.allowedRepos || ['calltelemetry/cisco-cdr', 'calltelemetry/review-yeti-bot']).map((r) => r.toLowerCase())
  );

  const authenticator: McpAuthenticator = {
    authenticate: async (req: Request) => {
      const header = req.header('authorization') || '';
      if (header === `Bearer ${VALID_E2E_TOKEN}`) {
        return {
          authType: 'static_token',
          tokenDigest: 'valid-digest-1',
          isAdmin: false,
          allowedRepositories: allowedRepos,
          callerId: 'e2e-tester',
        } satisfies McpAuthenticatedCaller;
      }
      if (header === `Bearer ${ADMIN_E2E_TOKEN}`) {
        return {
          authType: 'static_token',
          tokenDigest: 'admin-digest-1',
          isAdmin: true,
          allowedRepositories: null,
          callerId: 'e2e-admin',
        } satisfies McpAuthenticatedCaller;
      }
      throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
    },
    authenticateToken: async (token: string) => {
      if (token === VALID_E2E_TOKEN) {
        return {
          authType: 'static_token',
          tokenDigest: 'valid-digest-1',
          isAdmin: false,
          allowedRepositories: allowedRepos,
          callerId: 'e2e-tester',
        };
      }
      if (token === ADMIN_E2E_TOKEN) {
        return {
          authType: 'static_token',
          tokenDigest: 'admin-digest-1',
          isAdmin: true,
          allowedRepositories: null,
          callerId: 'e2e-admin',
        };
      }
      throw new McpAuthError('Unauthorized: Missing or invalid Bearer token');
    },
    checkRepositoryAccess: (caller: McpAuthenticatedCaller, owner: string, repo: string) => {
      if (caller.isAdmin) return true;
      return caller.allowedRepositories?.has(`${owner}/${repo}`.toLowerCase()) ?? false;
    },
    middleware: () => (_req: Request, _res: Response, next: any) => next(),
  } as unknown as McpAuthenticator;

  const toolRegistry = new DefaultMcpToolRegistry();

  // Register Core Tools with Mock DeepSeek & Database Dependencies
  toolRegistry.registerTool(createGetReviewStatusTool(db));
  toolRegistry.registerTool(createGetReviewFindingsTool(db));
  toolRegistry.registerTool(
    createPreflightDiffReviewTool({
      modelClient: {
        evaluateDiff: (prompt: string, signal?: AbortSignal) => deepSeek.evaluateDiff(prompt, signal),
      },
    })
  );
  toolRegistry.registerTool(
    createGenerateFixDiffTool({
      queryableDatabase: db,
    })
  );
  toolRegistry.registerTool(
    createDisputeFindingTool({
      queryableDatabase: db,
      adjudicateDispute: (finding: any, arg: string) => deepSeek.adjudicateDispute(finding, arg),
    })
  );
  toolRegistry.registerTool(
    createExplainFindingTool({
      queryableDatabase: db,
      modelClient: {
        generate: (prompt: string) => deepSeek.generate(prompt),
      },
    })
  );
  toolRegistry.registerTool(
    createTriggerReviewTool({
      queryableDatabase: db,
    })
  );

  const rateLimiter = new SlidingWindowRateLimiter({
    windowMs: customOptions.rateLimitWindowMs ?? 60_000,
    maxRequests: customOptions.rateLimitMax ?? 60,
    errorCode: MCP_ERRORS.RATE_LIMITED_ALT,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  // Tiered payload bound enforcement: 64KB standard, 512KB for preflight_diff_review (matches dispatchServer.ts)
  app.use('/api/mcp', (req: Request, res: Response, next: any) => {
    const isDiff = req.body?.method === 'tools/call' && req.body?.params?.name === 'preflight_diff_review';
    if (!isDiff && JSON.stringify(req.body || {}).length > 64 * 1024) {
      return res.status(413).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'request entity too large' },
        id: req.body?.id ?? null,
      });
    }
    next();
  });

  app.use('/api/mcp', rateLimiter.middleware());

  const router = createRemoteMcpRouter({
    authenticator,
    toolRegistry,
    db,
  });

  app.use('/api/mcp', router);

  const rpcCall = async (method: string, params?: Record<string, any>, token = VALID_E2E_TOKEN) => {
    const req = request(app).post('/api/mcp');
    if (token) {
      req.set('Authorization', `Bearer ${token}`);
    }
    return req.send({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method,
      params,
    });
  };

  const callTool = async (toolName: string, args: Record<string, any>, token = VALID_E2E_TOKEN) => {
    const res = await rpcCall('tools/call', { name: toolName, arguments: args }, token);
    const body = res.body;

    let parsedResult = null;
    if (body?.result) {
      if (typeof body.result === 'object' && body.result.content?.[0]?.text) {
        try {
          parsedResult = JSON.parse(body.result.content[0].text);
        } catch {
          parsedResult = body.result.content[0].text;
        }
      } else {
        parsedResult = body.result;
      }
    }

    return {
      result: parsedResult,
      error: body?.error,
      status: res.status,
    };
  };

  return {
    app,
    db,
    deepSeek,
    bifrost,
    router,
    rpcCall,
    callTool,
  };
}
