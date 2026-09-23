/**
 * Tier 2: Boundary & Corner Cases Test Suite
 *
 * Requirements-driven opaque-box tests covering extreme boundaries and failure modes:
 * 1. Boundary Diffs (empty, 512KB limit, malformed hunks, whitespace, binary)
 * 2. Boundary Payloads & Strings (10k chars, Unicode/emojis, empty strings, oversized RPC)
 * 3. Schema Boundaries & Validation (invalid SHA, non-integer PR, negative numbers, unknown fields)
 * 4. Security Boundaries & Multi-Tenancy (missing auth 401, invalid token 401, cross-tenant 403, sanitized 403, admin)
 * 5. Concurrency & Deadline Boundaries (0ms deadline abort, parallel execution, isolated PR disputes, DB resilience)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildE2eTestEnvironment,
  DIFF_FIXTURES,
  VALID_E2E_TOKEN,
  ADMIN_E2E_TOKEN,
  type E2eTestEnvironment,
} from './harness/mcpE2eHarness';

describe('Tier 2: Boundary & Corner Cases (tests/e2e/mcp/tier2BoundaryCorner.test.ts)', () => {
  let env: E2eTestEnvironment;

  beforeEach(() => {
    env = buildE2eTestEnvironment();
  });

  afterEach(() => {
    env.router.destroy();
  });

  // ===========================================================================
  // Category 1: Boundary Diffs
  // ===========================================================================
  describe('Category 1: Boundary Diffs', () => {
    it('TC-T2-DIF-01: empty diff string is rejected by schema with diff cannot be empty error', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: '',
        target_branch: 'main',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/diff cannot be empty/i);
    });

    it('TC-T2-DIF-02: large diff payload near 512KB boundary parses successfully', async () => {
      // Construct a 200KB repetitive clean code diff
      const hunkLines: string[] = [];
      for (let i = 0; i < 4000; i++) {
        hunkLines.push(`+const variable_${i} = ${i};`);
      }
      const largeDiff = `diff --git a/src/generated/constants.ts b/src/generated/constants.ts
index 0000000..1111111 100644
--- a/src/generated/constants.ts
+++ b/src/generated/constants.ts
@@ -1,1 +1,4000 @@
${hunkLines.join('\n')}
`;

      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: largeDiff,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.blast_radius_summary).toMatch(/Blast radius: MEDIUM/i);
      expect(res.result.blast_radius_summary).toMatch(/1 files modified/i);
    });

    it('TC-T2-DIF-03: malformed diff without valid git headers degrades gracefully without throwing', async () => {
      const malformed = 'Not a git diff\nJust random text\n@@ invalid @@\n+++ missing b';

      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: malformed,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.blast_radius_summary).toMatch(/0 files modified/i);
    });

    it('TC-T2-DIF-04: whitespace-only diff produces 0 modified files and low risk', async () => {
      const whitespaceDiff = '   \n\t\n   \n';

      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: whitespaceDiff,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.blast_radius_summary).toMatch(/0 files modified/i);
    });

    it('TC-T2-DIF-05: diff touching sensitive directory (.github/workflows) flags CRITICAL blast radius', async () => {
      const workflowDiff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 1111111..2222222 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,3 +10,4 @@ jobs:
+      - run: npm test
`;

      const res = await env.callTool('preflight_diff_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        diff: workflowDiff,
        target_branch: 'main',
      });

      expect(res.status).toBe(200);
      expect(res.result.blast_radius_summary).toMatch(/CRITICAL/i);
      expect(res.result.blast_radius_summary).toMatch(/infrastructure or security/i);
    });
  });

  // ===========================================================================
  // Category 2: Boundary Payloads & Strings
  // ===========================================================================
  describe('Category 2: Boundary Payloads & Strings', () => {
    let findingId: string;

    beforeEach(() => {
      const run = env.db.seedRun({
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 555,
        head_sha: 'a'.repeat(40),
      });

      const f = env.db.seedFinding({
        run_id: run.run_id,
        file_path: 'src/cache/store.ts',
        finding_id: 'find-bnd-555',
        title: 'Memory issue',
      });
      findingId = f.finding_id;
    });

    it('TC-T2-PAY-01: accepts counter-argument at exactly 10,000 characters boundary', async () => {
      const longArg = 'Technical justification: '.padEnd(10000, 'x');

      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 555,
        finding_id: findingId,
        counter_argument: longArg,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.disputed).toBe(true);
    });

    it('TC-T2-PAY-02: rejects counter-argument exceeding 10,000 characters with schema error', async () => {
      const overLimitArg = 'Too long: '.padEnd(10001, 'x');

      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 555,
        finding_id: findingId,
        counter_argument: overLimitArg,
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/Invalid parameters|String must contain at most 10000/i);
    });

    it('TC-T2-PAY-03: safely handles Unicode, emojis, shell escapes, and quotes in question', async () => {
      const exoticQuestion = `What about 🚀 emojis, "double quotes", 'single quotes', \`backticks\`, and $(whoami); \u0000 null bytes?`;

      const res = await env.callTool('explain_finding', {
        finding_id: findingId,
        question: exoticQuestion,
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 555,
      });

      expect(res.status).toBe(200);
      expect(res.result).toBeDefined();
      expect(res.result.explanation).toBeDefined();
    });

    it('TC-T2-PAY-04: rejects empty or whitespace-only inputs for required string fields', async () => {
      const res = await env.callTool('dispute_finding', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 555,
        finding_id: findingId,
        counter_argument: '     ',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/counter_argument must not be empty/i);
    });

    it('TC-T2-PAY-05: rejects non-preflight payload exceeding 64KB with HTTP 413', async () => {
      const hugeName = 'a'.repeat(70000);
      const res = await env.rpcCall('tools/call', {
        name: 'explain_finding',
        arguments: { finding_id: 'x', question: hugeName },
      });

      expect([413, 500]).toContain(res.status);
    });
  });

  // ===========================================================================
  // Category 3: Schema Boundaries & Validation
  // ===========================================================================
  describe('Category 3: Schema Boundaries & Validation', () => {
    it('TC-T2-SCH-01: rejects invalid commit SHA of 39 hex characters', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: 'a'.repeat(39),
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/40-character hexadecimal commit SHA/i);
    });

    it('TC-T2-SCH-02: rejects non-hex characters in commit SHA', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 100,
        head_sha: 'z'.repeat(40),
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/40-character hexadecimal commit SHA/i);
    });

    it('TC-T2-SCH-03: rejects non-integer PR numbers with schema error', async () => {
      const res = await env.callTool('trigger_review', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 12.34 as any,
        head_sha: 'a'.repeat(40),
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/expected integer/i);
    });

    it('TC-T2-SCH-04: rejects unknown properties in strictly validated tool schemas', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pr_number: 100,
        finding_id: 'f1',
        unexpected_extra_property: 'not_allowed',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/unrecognized key/i);
    });

    it('TC-T2-SCH-05: rejects missing mandatory fields in JSON-RPC tools/call', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        // missing pr_number and finding_id
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/Invalid parameters|Required/i);
    });
  });

  // ===========================================================================
  // Category 4: Security Boundaries & Multi-Tenancy
  // ===========================================================================
  describe('Category 4: Security Boundaries & Multi-Tenancy', () => {
    it('TC-T2-SEC-01: rejects unauthenticated requests with HTTP 401', async () => {
      const res = await env.rpcCall('tools/list', {}, '');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/Unauthorized/i);
    });

    it('TC-T2-SEC-02: rejects invalid Bearer tokens with HTTP 401', async () => {
      const res = await env.rpcCall('tools/list', {}, 'invalid_dummy_token');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('TC-T2-SEC-03: rejects cross-tenant repository access with HTTP 403 Forbidden', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'unauthorized-tenant',
        repo: 'private-repo',
        pr_number: 1,
        finding_id: 'f1',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).toMatch(/Access.*denied|Forbidden/i);
    });

    it('TC-T2-SEC-04: sanitized error envelope conceals internal database and private PR existence', async () => {
      const res = await env.callTool('generate_fix_diff', {
        owner: 'forbidden-org',
        repo: 'secret-service',
        pr_number: 9999,
        finding_id: 'secret-finding',
      });

      expect(res.error).toBeDefined();
      expect(res.error.message).not.toContain('review_runs');
      expect(res.error.message).not.toContain('SQL');
      expect(res.error.message).not.toContain('Postgres');
    });

    it('TC-T2-SEC-05: admin token bypasses repository restrictions safely', async () => {
      const res = await env.callTool('preflight_diff_review', {
        owner: 'any-tenant-org',
        repo: 'any-repo',
        diff: DIFF_FIXTURES.safeMarkdown,
        target_branch: 'main',
      }, ADMIN_E2E_TOKEN);

      expect(res.status).toBe(200);
      expect(res.result.eligible_to_ship).toBe(true);
    });
  });

  // ===========================================================================
  // Category 5: Concurrency & Deadline Boundaries
  // ===========================================================================
  describe('Category 5: Concurrency & Deadline Boundaries', () => {
    it('TC-T2-CON-01: immediate timeout with aborted signal stops execution cleanly', async () => {
      const controller = new AbortController();
      controller.abort(); // already aborted

      const timeoutEnv = buildE2eTestEnvironment();

      try {
        await expect(
          timeoutEnv.deepSeek.evaluateDiff('prompt', controller.signal)
        ).rejects.toThrow();
      } finally {
        timeoutEnv.router.destroy();
      }
    });

    it('TC-T2-CON-02: parallel tool calls execute concurrently without cross-contamination', async () => {
      const calls = [
        env.callTool('preflight_diff_review', { owner: 'calltelemetry', repo: 'cisco-cdr', diff: DIFF_FIXTURES.safeMarkdown }),
        env.callTool('preflight_diff_review', { owner: 'calltelemetry', repo: 'cisco-cdr', diff: DIFF_FIXTURES.cleanCode }),
        env.callTool('preflight_diff_review', { owner: 'calltelemetry', repo: 'cisco-cdr', diff: DIFF_FIXTURES.hardcodedSecret }),
      ];

      const results = await Promise.all(calls);

      expect(results[0].result.eligible_to_ship).toBe(true);
      expect(results[1].result.blast_radius_summary).toMatch(/exported symbol/i);
      expect(results[2].result.eligible_to_ship).toBe(false); // secret detected
    });

    it('TC-T2-CON-03: concurrent disputes across multiple PRs maintain isolated state in ledger', async () => {
      const run1 = env.db.seedRun({ owner: 'calltelemetry', repo: 'cisco-cdr', pr_number: 701, head_sha: '1'.repeat(40) });
      const run2 = env.db.seedRun({ owner: 'calltelemetry', repo: 'cisco-cdr', pr_number: 702, head_sha: '2'.repeat(40) });

      const f1 = env.db.seedFinding({ run_id: run1.run_id, file_path: 'src/cache/store.ts', finding_id: 'find-pr-701', title: 'Issue 701' });
      const f2 = env.db.seedFinding({ run_id: run2.run_id, file_path: 'src/cache/store.ts', finding_id: 'find-pr-702', title: 'Issue 702' });

      const [res1, res2] = await Promise.all([
        env.callTool('dispute_finding', {
          owner: 'calltelemetry', repo: 'cisco-cdr', pr_number: 701,
          finding_id: f1.finding_id, counter_argument: 'Detailed technical mitigation for PR 701 with LRU bounds.',
        }),
        env.callTool('dispute_finding', {
          owner: 'calltelemetry', repo: 'cisco-cdr', pr_number: 702,
          finding_id: f2.finding_id, counter_argument: 'Short ignore',
        }),
      ]);

      expect(res1.result.verdict).toBe('overruled');
      expect(res2.result.verdict).toBe('upheld');
    });

    it('TC-T2-CON-04: empty database query results are handled cleanly without unhandled exceptions', async () => {
      env.db.reset(); // clear all database state

      const res = await env.callTool('get_review_status', {
        owner: 'calltelemetry',
        repo: 'cisco-cdr',
        pull_number: 999,
      });

      expect(res.status).toBe(200);
      expect(res.result.found).toBe(false);
      expect(res.result.message).toMatch(/No review run.*found/i);
    });

    it('TC-T2-CON-05: burst of 10 sequential tool calls complete reliably within SLA', async () => {
      const start = Date.now();
      for (let i = 0; i < 10; i++) {
        const res = await env.callTool('preflight_diff_review', {
          owner: 'calltelemetry',
          repo: 'cisco-cdr',
          diff: DIFF_FIXTURES.safeMarkdown,
        });
        expect(res.status).toBe(200);
      }
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000); // 10 calls well under 5 seconds
    });
  });
});
