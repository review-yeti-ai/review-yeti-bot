/**
 * Tier 1: Feature Coverage Test Suite
 *
 * Requirements-driven opaque-box tests exercising all core features:
 * 1. Model-Backed preflight_diff_review (safe bypass, AST radius, secrets, SQLi, DeepSeek)
 * 2. Model-Backed generate_fix_diff (unified diff, hunk headers, additions, deletions, DB lookup)
 * 3. Model-Backed dispute_finding (technical rebuttal, dismissive rebuttal, model eval, blockers)
 * 4. Model-Backed explain_finding (inquiry, non-compliant fix, compliant fix, tenancy, 404)
 * 5. trigger_review Engine Selection (default panel, composed, panel, 409 conflict)
 * 6. Outbound Fleet MCP Discovery & Execution (ct-impact, ct-knowledge, blocker-quorum, rbac)
 * 7. Context Deadlines, Timeouts & Degradation (model timeout, fleet timeout, abort, 429)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildE2eTestEnvironment,
  DIFF_FIXTURES,
  MCP_ERRORS,
  type E2eTestEnvironment,
} from './harness/mcpE2eHarness';

describe('Tier 1: Feature Coverage (tests/e2e/mcp/tier1FeatureCoverage.test.ts)', () => {
  let env: E2eTestEnvironment;

  beforeEach(() => {
    env = buildE2eTestEnvironment();
  });

  afterEach(() => {
    env.router.destroy();
  });

  // ===========================================================================
  // Feature 1: Model-Backed preflight_diff_review
  // ===========================================================================
  describe('Feature 1: Model-Backed preflight_diff_review', () => {
    it('TC-T1-PRE-01: safe non-code modification bypasses heavy review for fast-ship', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.safeMarkdown,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.eligible_to_ship).toBe(true);
      expect(res.result.findings).toEqual([]);
      expect(res.result.blast_radius_summary).toMatch(/Safe non-code modification.*Eligible for fast-ship/i);
    });

    it('TC-T1-PRE-02: calculates AST blast radius for code additions and exported symbols', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.cleanCode,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.blast_radius_summary).toMatch(/Blast radius:/i);
      expect(res.result.blast_radius_summary).toMatch(/exported symbol\(s\) modified/i);
    });

    it('TC-T1-PRE-03: detects hardcoded secret token and marks PR ineligible to ship', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.hardcodedSecret,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.eligible_to_ship).toBe(false);
      expect(res.result.findings.length).toBeGreaterThanOrEqual(1);

      const secretFinding = res.result.findings.find((f: any) => f.category === 'Security');
      expect(secretFinding).toBeDefined();
      expect(secretFinding.severity).toBe('P0');
      expect(secretFinding.title).toMatch(/secret token or credential/i);
      expect(secretFinding.file_path).toBe('src/auth/client.ts');
    });

    it('TC-T1-PRE-04: detects SQL injection and command injection static vulnerabilities', async () => {
      const sqlRes = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.sqlInjection,
        target_branch: 'main',
      });

      expect(sqlRes.result.eligible_to_ship).toBe(false);
      const sqliFinding = sqlRes.result.findings.find((f: any) => f.finding_id.includes('sqli'));
      expect(sqliFinding).toBeDefined();
      expect(sqliFinding.severity).toBe('P0');
      expect(sqliFinding.suggested_fix).toMatch(/parameterized SQL query/i);

      const cmdRes = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.commandInjection,
        target_branch: 'main',
      });

      expect(cmdRes.result.eligible_to_ship).toBe(false);
      const cmdFinding = cmdRes.result.findings.find((f: any) => f.finding_id.includes('cmdi'));
      expect(cmdFinding).toBeDefined();
      expect(cmdFinding.severity).toBe('P0');
    });

    it('TC-T1-PRE-05: incorporates DeepSeek model review findings when diff passes static checks', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: DIFF_FIXTURES.cleanCode,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(env.deepSeek.evaluateDiffCalls.length).toBe(1);
      expect(env.deepSeek.evaluateDiffCalls[0].prompt).toMatch(/Review diff for repo cisco-cdr/i);
      expect(res.result.findings.length).toBeGreaterThanOrEqual(1);
      expect(res.result.findings[0].finding_id).toBe('deepseek-p1-001');
      expect(res.result.findings[0].severity).toBe('P1');
      expect(res.result.eligible_to_ship).toBe(false); // P1 blocks ship
    });
  });

  // ===========================================================================
  // Feature 2: Model-Backed generate_fix_diff
  // ===========================================================================
  describe('Feature 2: Model-Backed generate_fix_diff', () => {
    let runId: string;
    let findingId: string;

    beforeEach(() => {
      const run = env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        head_sha: 'a'.repeat(40),
      });
      runId = run.run_id;

      const f = env.db.seedFinding({
        run_id: runId,
        finding_id: 'find-sec-101',
        title: 'Hardcoded secret token in auth client',
        file_path: 'src/auth/client.ts',
        line_start: 12,
        line_end: 12,
        originalCode: 'const apiKey = "secret_12345";',
        replacementCode: 'const apiKey = process.env.API_KEY || "";',
        rationale: 'Plaintext secret violates ADR 0564.',
        suggested_fix: 'Load API key from environment variable.',
      });
      findingId = f.finding_id;
    });

    it('TC-T1-FIX-01: synthesizes exact unified diff patch with valid hunk headers', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: findingId,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.file_path).toBe('src/auth/client.ts');
      expect(res.result.patch).toContain('--- a/src/auth/client.ts');
      expect(res.result.patch).toContain('+++ b/src/auth/client.ts');
      expect(res.result.patch).toContain('@@ -12,1 +12,1 @@');
      expect(res.result.patch).toContain('-const apiKey = "secret_12345";');
      expect(res.result.patch).toContain('+const apiKey = process.env.API_KEY || "";');
    });

    it('TC-T1-FIX-02: synthesizes multi-line code replacement patch with accurate line count', async () => {
      const f = env.db.seedFinding({
        run_id: runId,
        finding_id: 'find-multi-line-202',
        title: 'Unbounded loop query',
        file_path: 'src/db/query.ts',
        line_start: 30,
        line_end: 32,
        originalCode: 'for (const id of ids) {\n  await fetch(id);\n}',
        replacementCode: 'const batch = ids.slice(0, 10);\nawait Promise.all(batch.map(fetch));',
      });

      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: f.finding_id,
      });

      expect(res.status).toBe(200);
      expect(res.result.patch).toContain('@@ -30,3 +30,2 @@');
      expect(res.result.patch).toContain('-for (const id of ids) {');
      expect(res.result.patch).toContain('+const batch = ids.slice(0, 10);');
    });

    it('TC-T1-FIX-03: synthesizes pure addition patch without deleting lines', async () => {
      const f = env.db.seedFinding({
        run_id: runId,
        finding_id: 'find-insert-303',
        title: 'Missing input validation',
        file_path: 'src/api/handler.ts',
        line_start: 15,
        line_end: 15,
        originalCode: '',
        replacementCode: 'if (!req.body.id) throw new Error("ID required");',
      });

      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: f.finding_id,
      });

      expect(res.status).toBe(200);
      expect(res.result.patch).toContain('@@ -15,0 +15,1 @@');
      expect(res.result.patch).toContain('+if (!req.body.id) throw new Error("ID required");');
    });

    it('TC-T1-FIX-04: synthesizes pure deletion patch without replacement lines', async () => {
      const f = env.db.seedFinding({
        run_id: runId,
        finding_id: 'find-delete-404',
        title: 'Dead legacy debug statement',
        file_path: 'src/utils/debug.ts',
        line_start: 5,
        line_end: 5,
        originalCode: 'console.log("DEBUG_RAW_PAYLOAD:", payload);',
        replacementCode: '',
      });

      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: f.finding_id,
      });

      expect(res.status).toBe(200);
      expect(res.result.patch).toContain('@@ -5,1 +5,0 @@');
      expect(res.result.patch).toContain('-console.log("DEBUG_RAW_PAYLOAD:", payload);');
    });

    it('TC-T1-FIX-05: throws informative error when finding ID does not exist in ledger', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 101,
        finding_id: 'nonexistent-finding-999',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/was not found in review ledger/i);
    });
  });

  // ===========================================================================
  // Feature 3: Model-Backed dispute_finding
  // ===========================================================================
  describe('Feature 3: Model-Backed dispute_finding', () => {
    let findingId: string;

    beforeEach(() => {
      const run = env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        head_sha: 'b'.repeat(40),
      });

      const f = env.db.seedFinding({
        run_id: run.run_id,
        file_path: 'src/cache/store.ts',
        finding_id: 'pref-leak-202',
        title: 'Potential memory leak in cache buffer',
        severity: 'P1',
        rationale: 'Cache buffer has no explicit max keys or eviction policy.',
      });
      findingId = f.finding_id;
    });

    it('TC-T1-DIS-01: accepts substantive technical justification and overrules finding', async () => {
      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        finding_id: findingId,
        counter_argument: 'The buffer is bounded by an LRU cache limited to 500 items configured in CacheManager, preventing memory leaks.',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.finding_id).toBe(findingId);
      expect(res.result.disputed).toBe(true);
      expect(res.result.verdict).toBe('overruled');
      expect(res.result.remaining_blockers).toBe(0);
      expect(res.result.reasoning).toMatch(/Technical mitigation/i);
    });

    it('TC-T1-DIS-02: rejects dismissive low-effort rebuttal and upholds blocker finding', async () => {
      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        finding_id: findingId,
        counter_argument: 'Whatever not a bug ignore this',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.verdict).toBe('upheld');
      expect(res.result.remaining_blockers).toBe(1);
      expect(res.result.reasoning).toMatch(/lacks technical evidence/i);
    });

    it('TC-T1-DIS-03: invokes DeepSeek model adjudication callback with technical context', async () => {
      env.deepSeek.options.disputeDecision = {
        verdict: 'overruled',
        reasoning: 'DeepSeek Quorum verified ADR 0564 compliance in surrounding module context.',
      };

      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        finding_id: findingId,
        counter_argument: 'Surrounding module uses bounded worker channels with backpressure per ADR 0564.',
      });

      expect(res.status).toBe(200);
      expect(env.deepSeek.disputeCalls.length).toBe(1);
      expect(res.result.verdict).toBe('overruled');
      expect(res.result.reasoning).toContain('DeepSeek Quorum verified ADR 0564 compliance');
    });

    it('TC-T1-DIS-04: recalculates remaining blockers in ledger when finding is overruled', async () => {
      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        finding_id: findingId,
        counter_argument: 'Verified LRU bounds are present in cache.ts:32 with 100 max entries.',
      });

      expect(res.result.verdict).toBe('overruled');
      expect(res.result.remaining_blockers).toBe(0);
    });

    it('TC-T1-DIS-05: throws when disputing nonexistent finding ID in repository', async () => {
      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 202,
        finding_id: 'unknown-finding-xyz',
        counter_argument: 'Technical justification for nonexistent finding.',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/was not found in review ledger/i);
    });
  });

  // ===========================================================================
  // Feature 4: Model-Backed explain_finding
  // ===========================================================================
  describe('Feature 4: Model-Backed explain_finding', () => {
    let findingId: string;

    beforeEach(() => {
      const run = env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 303,
        head_sha: 'c'.repeat(40),
      });

      const f = env.db.seedFinding({
        run_id: run.run_id,
        finding_id: 'find-exp-303',
        title: 'Unbounded queue growth',
        severity: 'P1',
        file_path: 'src/queue/dispatcher.ts',
        line_start: 45,
        line_end: 50,
        violated_adrs: ['ADR 0564', 'ADR 0242'],
        rationale: 'In-memory queue has no max length and will cause memory leak under high load.',
        suggested_fix: 'Use a bounded ring buffer or drop-oldest strategy.',
      });
      findingId = f.finding_id;
    });

    it('TC-T1-EXP-01: explains finding details and cites violated ADRs for informational inquiries', async () => {
      const res = await env.callTool('explain_finding', {
        finding_id: findingId,
        question: 'Why was this finding raised and what ADR governs it?',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 303,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.explanation).toMatch(/ADR 0564/i);
      expect(res.result.explanation).toMatch(/src\/queue\/dispatcher\.ts:45-50/i);
      expect(res.result.satisfies_requirement).toBeNull();
    });

    it('TC-T1-EXP-02: evaluates non-compliant proposal (bypassing check) as satisfies_requirement = false', async () => {
      const res = await env.callTool('explain_finding', {
        finding_id: findingId,
        question: 'Can I just disable or turn off the queue check to fix this?',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 303,
      });

      expect(res.status).toBe(200);
      expect(res.result.satisfies_requirement).toBe(false);
      expect(res.result.explanation).toMatch(/does not satisfy the requirements/i);
      expect(res.result.explanation).toMatch(/Disabling or removing safety controls fails to address the root issue/i);
    });

    it('TC-T1-EXP-03: evaluates compliant proposal (bounded ring buffer) as satisfies_requirement = true', async () => {
      const res = await env.callTool('explain_finding', {
        finding_id: findingId,
        question: 'What if I implement a bounded ring buffer with an LRU capacity limit of 1000 items?',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 303,
      });

      expect(res.status).toBe(200);
      expect(res.result.satisfies_requirement).toBe(true);
      expect(res.result.explanation).toMatch(/satisfies the architectural and safety requirements/i);
    });

    it('TC-T1-EXP-04: scopes finding lookup by owner, repo, and pull number tenancy', async () => {
      const res = await env.callTool('explain_finding', {
        finding_id: findingId,
        question: 'Explain the finding context',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 303,
      });

      expect(res.status).toBe(200);
      expect(res.result.explanation).toContain('P1 - Unbounded queue growth');
    });

    it('TC-T1-EXP-05: returns diagnostic guidance when finding ID is not in ledger', async () => {
      const res = await env.callTool('explain_finding', {
        finding_id: 'unknown-id-888',
        question: 'Explain this finding',
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 303,
      });

      expect(res.status).toBe(200);
      expect(res.result.explanation).toMatch(/was not found in the review ledger/i);
      expect(res.result.satisfies_requirement).toBeNull();
    });
  });

  // ===========================================================================
  // Feature 5: trigger_review Engine Selection Routing
  // ===========================================================================
  describe('Feature 5: trigger_review Engine Selection Routing', () => {
    it('TC-T1-ENG-01: admits review with standard exact-head parameters', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 404,
        head_sha: 'd'.repeat(40),
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.dispatched).toBe(true);
      expect(res.result.attempt_id).toMatch(/review-attempt-404/i);
    });

    it('TC-T1-ENG-02: verifies review priority specification (normal vs expedited)', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 405,
        head_sha: 'e'.repeat(40),
        priority: 'expedited',
      });

      expect(res.status).toBe(200);
      expect(res.result.dispatched).toBe(true);
      expect(res.result.message).toMatch(/priority: expedited/i);
    });

    it('TC-T1-ENG-03: rejects invalid head commit SHA format (<40 hex characters)', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 406,
        head_sha: 'short-sha',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/40-character hexadecimal/i);
    });

    it('TC-T1-ENG-04: rejects negative or invalid pull request numbers', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: -5,
        head_sha: 'f'.repeat(40),
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/positive integer/i);
    });

    it('TC-T1-ENG-05: detects active review conflict and rejects concurrent trigger without force', async () => {
      // Seed an active running review
      env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 407,
        head_sha: '1'.repeat(40),
        status: 'running',
      });

      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 407,
        head_sha: '1'.repeat(40),
        force: false,
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/Conflict: Review attempt.*is currently running/i);
    });
  });

  // ===========================================================================
  // Feature 6: Outbound Fleet MCP Discovery & Execution
  // ===========================================================================
  describe('Feature 6: Outbound Fleet MCP Discovery & Execution', () => {
    it('TC-T1-FLT-01: discovers read-only fleet tools from Bifrost gateway catalog', () => {
      const tools = env.bifrost.listTools();
      const toolNames = tools.map((t) => t.name);

      expect(toolNames).toContain('ct_impact');
      expect(toolNames).toContain('ct_mesh_query');
      expect(toolNames).toContain('knowledge_search');
      expect(toolNames).toContain('knowledge_get');
      expect(toolNames).toContain('advise_blocker');
      expect(toolNames).toContain('health');
    });

    it('TC-T1-FLT-02: executes ct_impact blast radius and AST mesh query over Bifrost', async () => {
      const res = await env.bifrost.executeTool('ct_impact', { target_file: 'src/billing/service.ts' });

      expect(res.success).toBe(true);
      expect(res.output).toBeDefined();
      expect(res.output.blast_radius).toBe('MEDIUM');
      expect(res.output.transitive_callers).toBe(8);
      expect(res.output.affected_repos).toContain('calltelemetry/cisco-cdr');
    });

    it('TC-T1-FLT-03: executes knowledge_search ADR query and retrieves architectural policies', async () => {
      const res = await env.bifrost.executeTool('knowledge_search', { query: 'memory buffer limit' });

      expect(res.success).toBe(true);
      expect(res.output.adrs.length).toBeGreaterThanOrEqual(1);

      const adr = res.output.adrs.find((a: any) => a.id === 'ADR 0564');
      expect(adr).toBeDefined();
      expect(adr.title).toMatch(/Bounded Memory Allocation/i);
      expect(adr.status).toBe('ACCEPTED');
    });

    it('TC-T1-FLT-04: executes advise_blocker active policy check via blocker-quorum', async () => {
      const res = await env.bifrost.executeTool('advise_blocker', { repository: 'calltelemetry/cisco-cdr' });

      expect(res.success).toBe(true);
      expect(res.output.active_blockers).toBe(0);
      expect(res.output.quorum_state).toBe('CONSENSUS_REACHED');
      expect(res.output.advisory).toMatch(/eligible for gate clearance/i);
    });

    it('TC-T1-FLT-05: rejects mutating tool execution in read-only review context', async () => {
      const res = await env.bifrost.executeTool('memory_record', { key: 'new_fact', value: 'data' });

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Permission Denied: Mutating tool.*is prohibited/i);
    });
  });

  // ===========================================================================
  // Feature 7: Context Deadlines, Timeouts & Graceful Degradation
  // ===========================================================================
  describe('Feature 7: Context Deadlines, Timeouts & Graceful Degradation', () => {
    it('TC-T1-DEG-01: preflight review gracefully degrades to static heuristics on model timeout', async () => {
      const timeoutEnv = buildE2eTestEnvironment({
        deepSeekOptions: { shouldTimeout: true },
      });

      try {
        const res = await timeoutEnv.callTool('preflight_diff_review', {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          diff: DIFF_FIXTURES.cleanCode,
          target_branch: 'main',
        });

        expect(res.status).toBe(200);
        expect(res.result).toBeDefined();
        // Model timed out: falls back to static checks (0 findings on clean code)
        expect(res.result.eligible_to_ship).toBe(true);
        expect(res.result.findings).toEqual([]);
      } finally {
        timeoutEnv.router.destroy();
      }
    });

    it('TC-T1-DEG-02: preflight review gracefully degrades when model client returns 502 error', async () => {
      const errorEnv = buildE2eTestEnvironment({
        deepSeekOptions: { shouldError: true },
      });

      try {
        const res = await errorEnv.callTool('preflight_diff_review', {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          diff: DIFF_FIXTURES.cleanCode,
          target_branch: 'main',
        });

        expect(res.status).toBe(200);
        expect(res.result.eligible_to_ship).toBe(true);
      } finally {
        errorEnv.router.destroy();
      }
    });

    it('TC-T1-DEG-03: outbound fleet tool returns clean error envelope when Bifrost is offline', async () => {
      env.bifrost.isOnline = false;

      const res = await env.bifrost.executeTool('ct_impact', { target_file: 'src/billing/service.ts' });

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/connection refused/i);
    });

    it('TC-T1-DEG-04: sliding window rate limiter throttles burst requests with HTTP 429', async () => {
      const limitedEnv = buildE2eTestEnvironment({
        rateLimitMax: 2,
        rateLimitWindowMs: 60_000,
      });

      try {
        // Request 1: OK
        const res1 = await limitedEnv.rpcCall('tools/list');
        expect(res1.status).toBe(200);

        // Request 2: OK
        const res2 = await limitedEnv.rpcCall('tools/list');
        expect(res2.status).toBe(200);

        // Request 3: Exceeded limit -> HTTP 429
        const res3 = await limitedEnv.rpcCall('tools/list');
        expect(res3.status).toBe(429);
        expect(res3.body.error).toBeDefined();
        expect(res3.body.error.code).toBe(MCP_ERRORS.RATE_LIMITED_ALT);
      } finally {
        limitedEnv.router.destroy();
      }
    });

    it('TC-T1-DEG-05: abort signal propagates and halts long-running evaluations cleanly', async () => {
      const controller = new AbortController();
      controller.abort();

      const timeoutEnv = buildE2eTestEnvironment();

      try {
        await expect(timeoutEnv.deepSeek.evaluateDiff('test prompt', controller.signal)).rejects.toThrow(/Aborted/i);
      } finally {
        timeoutEnv.router.destroy();
      }
    });
  });
});
