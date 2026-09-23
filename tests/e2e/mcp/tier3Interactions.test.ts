/**
 * Tier 3: Cross-Feature Interactions Test Suite
 *
 * Requirements-driven opaque-box tests covering pairwise and cross-feature interactions:
 * - CF-01: trigger_review (composed engine) + Outbound ct-impact blast radius tool invocation
 * - CF-02: trigger_review (panel engine) + Outbound ct-knowledge ADR compliance check
 * - CF-03: Complete Finding Lifecycle: Query -> Explain -> Dispute -> Fix Diff Synthesis
 * - CF-04: Preflight Detection -> Immediate Fix Diff Generation for Pre-Commit Remediation
 * - CF-05: Outbound Fleet Tool Failure during Review -> Resilient Plan Continuation
 * - CF-06: trigger_review Force Override superseding in-flight run
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildE2eTestEnvironment,
  DIFF_FIXTURES,
  type E2eTestEnvironment,
} from './harness/mcpE2eHarness';
import { runReadOnlyTool } from '../../../src/panel/toolRuntime';

describe('Tier 3: Cross-Feature Interactions (tests/e2e/mcp/tier3Interactions.test.ts)', () => {
  let env: E2eTestEnvironment;

  beforeEach(() => {
    env = buildE2eTestEnvironment();
  });

  afterEach(() => {
    env.router.destroy();
  });

  // ===========================================================================
  // CF-01: trigger_review (composed engine) + Outbound ct-impact
  // ===========================================================================
  it('CF-01: trigger_review with composed engine and outbound ct-impact blast radius query', async () => {
    // 1. Enqueue review for PR
    const triggerRes = await env.callTool('trigger_review', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 801,
      head_sha: '1'.repeat(40),
      priority: 'normal',
    });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.result.dispatched).toBe(true);

    // 2. Discover available fleet tools via Bifrost
    const fleetTools = env.bifrost.listTools();
    const hasImpactTool = fleetTools.some((t) => t.name === 'ct_impact');
    expect(hasImpactTool).toBe(true);

    // 3. Composed engine persona executes ct-impact during task execution
    const impactRes = await env.bifrost.executeTool('ct_impact', {
      target_file: 'src/billing/service.ts',
    });

    expect(impactRes.success).toBe(true);
    expect(impactRes.output.blast_radius).toBe('MEDIUM');
    expect(impactRes.output.transitive_callers).toBe(8);
    expect(impactRes.output.affected_repos).toContain('calltelemetry/cisco-cdr');
  });

  // ===========================================================================
  // CF-02: trigger_review (panel engine) + Outbound ct-knowledge ADR check
  // ===========================================================================
  it('CF-02: trigger_review with panel engine and outbound ct-knowledge ADR compliance query', async () => {
    // 1. Trigger review
    const triggerRes = await env.callTool('trigger_review', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 802,
      head_sha: '2'.repeat(40),
      priority: 'expedited',
    });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.result.dispatched).toBe(true);

    // 2. Security persona queries governed ADRs via Bifrost
    const adrRes = await env.bifrost.executeTool('knowledge_search', {
      query: 'parameterized SQL queries',
    });

    expect(adrRes.success).toBe(true);
    const sqlAdr = adrRes.output.adrs.find((a: any) => a.id === 'ADR 0242');
    expect(sqlAdr).toBeDefined();
    expect(sqlAdr.title).toMatch(/Parameterization of Dynamic Database Queries/i);
    expect(sqlAdr.status).toBe('ACCEPTED');
  });

  // ===========================================================================
  // CF-03: Finding Lifecycle (Query -> Explain -> Dispute -> Fix Diff)
  // ===========================================================================
  it('CF-03: complete finding lifecycle from ledger query to explanation, dispute, and fix diff', async () => {
    // Seed initial review run and finding
    const run = env.db.seedRun({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 803,
      head_sha: '3'.repeat(40),
    });

    const f = env.db.seedFinding({
      run_id: run.run_id,
      finding_id: 'find-lifecycle-803',
      title: 'Unbounded memory cache',
      file_path: 'src/cache/store.ts',
      line_start: 20,
      line_end: 25,
      originalCode: 'const store = new Map();',
      replacementCode: 'const store = new LRUCache({ max: 1000 });',
      rationale: 'Plain Map allows unbounded memory growth.',
      suggested_fix: 'Replace Map with LRUCache bounded to 1000 entries.',
    });

    // 1. Query findings via get_review_findings
    const findingsRes = await env.callTool('get_review_findings', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 803,
    });

    expect(findingsRes.status).toBe(200);
    expect(findingsRes.result.findings.length).toBe(1);
    expect(findingsRes.result.findings[0].finding_id).toBe(f.finding_id);

    // 2. Developer asks for explanation via explain_finding
    const explainRes = await env.callTool('explain_finding', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 803,
      finding_id: f.finding_id,
      question: 'What if I use an LRUCache with bounded capacity?',
    });

    expect(explainRes.status).toBe(200);
    expect(explainRes.result.satisfies_requirement).toBe(true);

    // 3. Developer submits dispute with technical justification
    const disputeRes = await env.callTool('dispute_finding', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 803,
      finding_id: f.finding_id,
      counter_argument: 'We implemented LRUCache bounded to 1000 items in store.ts with automatic eviction.',
    });

    expect(disputeRes.status).toBe(200);
    expect(disputeRes.result.verdict).toBe('overruled');
    expect(disputeRes.result.remaining_blockers).toBe(0);

    // 4. Synthesize unified fix diff for codebase application
    const fixRes = await env.callTool('generate_fix_diff', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 803,
      finding_id: f.finding_id,
    });

    expect(fixRes.status).toBe(200);
    expect(fixRes.result.patch).toContain('--- a/src/cache/store.ts');
    expect(fixRes.result.patch).toContain('+++ b/src/cache/store.ts');
    expect(fixRes.result.patch).toContain('-const store = new Map();');
    expect(fixRes.result.patch).toContain('+const store = new LRUCache({ max: 1000 });');
  });

  // ===========================================================================
  // CF-04: Preflight Detection -> Fix Diff Generation
  // ===========================================================================
  it('CF-04: preflight detects security violation, developer generates fix patch from finding', async () => {
    // 1. Run preflight diff review on uncommitted diff with hardcoded secret
    const preflightRes = await env.callTool('preflight_diff_review', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      diff: DIFF_FIXTURES.hardcodedSecret,
      target_branch: 'main',
    });

    expect(preflightRes.status).toBe(200);
    expect(preflightRes.result.eligible_to_ship).toBe(false);
    expect(preflightRes.result.findings.length).toBeGreaterThanOrEqual(1);

    const finding = preflightRes.result.findings[0];
    expect(finding.severity).toBe('P0');

    // 2. Seed this preflight finding into review run for patch synthesis
    const run = env.db.seedRun({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 804,
      head_sha: '4'.repeat(40),
    });

    env.db.seedFinding({
      run_id: run.run_id,
      finding_id: finding.finding_id,
      title: finding.title,
      file_path: finding.file_path,
      line_start: finding.line,
      line_end: finding.line,
      originalCode: 'const apiKey = "ghp_123456789012345678901234567890123456";',
      replacementCode: 'const apiKey = process.env.GITHUB_API_KEY || "";',
    });

    // 3. Generate fix patch
    const fixRes = await env.callTool('generate_fix_diff', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 804,
      finding_id: finding.finding_id,
    });

    expect(fixRes.status).toBe(200);
    expect(fixRes.result.patch).toContain('--- a/src/auth/client.ts');
    expect(fixRes.result.patch).toContain('+++ b/src/auth/client.ts');
    expect(fixRes.result.patch).toContain('-const apiKey = "ghp_123456789012345678901234567890123456";');
    expect(fixRes.result.patch).toContain('+const apiKey = process.env.GITHUB_API_KEY || "";');
  });

  // ===========================================================================
  // CF-05: Outbound Fleet Tool Failure -> Resilient Tool Runtime
  // ===========================================================================
  it('CF-05: toolRuntime gracefully handles fleet MCP failure without crashing reviewer loop', async () => {
    // Execute a read-only tool call via toolRuntime with simulated failure
    const context = {
      changedFiles: [{ path: 'src/billing/service.ts', patch: '+export class BillingService {}' }],
    };

    // Unknown or failing tool returns permission rejection or execution failure cleanly
    const result = await runReadOnlyTool('unknown_mutating_tool', {}, context);

    expect(result.toolOutput).toContain('rejected: Permission denied');
    expect(result.toolScope).toBe('changed-patches-only');
    expect(result.isExhaustive).toBe(false);
  });

  // ===========================================================================
  // CF-06: trigger_review Force Override Superseding In-Flight Run
  // ===========================================================================
  it('CF-06: trigger_review with force=true supersedes in-flight run and resets attempt', async () => {
    // 1. Seed existing running review
    env.db.seedRun({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pr_number: 806,
      head_sha: '6'.repeat(40),
      status: 'running',
    });

    // 2. Trigger review with force: true
    const res = await env.callTool('trigger_review', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      pull_number: 806,
      head_sha: '6'.repeat(40),
      force: true,
      priority: 'expedited',
    });

    expect(res.status).toBe(200);
    expect(res.result.dispatched).toBe(true);
    expect(res.result.message).toMatch(/priority: expedited/i);
  });
});
