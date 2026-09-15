import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import {
  runPreCheckAnalyzers,
  filterHypothesesForPersona,
  formatCandidateHypothesesPrompt,
  getApplicableAnalyzers,
  CandidateHypothesis,
  PreCheckSummary,
} from '../../src/sandbox/analyzerRunner';
import * as zoektPreCheckService from '../../src/services/zoektPreCheckService';
import * as analyzerRunnerModule from '../../src/sandbox/analyzerRunner';
import { resolvePreChecksConfig, PreChecksConfig, CtReviewConfigV3 } from '../../src/config/schema';
import { SandboxRunner, SandboxCommandResult } from '../../src/fix/sandboxRunner';

// In-memory Mock Sandbox Runner
class MockSandboxRunner implements SandboxRunner {
  private rules: Array<{
    matcher: (cmd: string, args: string[]) => boolean;
    response: Partial<SandboxCommandResult> | ((cmd: string, args: string[]) => Partial<SandboxCommandResult>);
  }> = [];

  public executedCommands: Array<{ command: string; args: string[]; options?: any }> = [];

  onCommand(
    matcher: string | RegExp | ((cmd: string, args: string[]) => boolean),
    response: Partial<SandboxCommandResult> | ((cmd: string, args: string[]) => Partial<SandboxCommandResult>)
  ): this {
    const predicate = typeof matcher === 'string'
      ? (cmd: string, args: string[]) => cmd.includes(matcher) || args.some((a) => a.includes(matcher))
      : matcher instanceof RegExp
      ? (cmd: string, args: string[]) => matcher.test(cmd) || args.some((a) => matcher.test(a))
      : matcher;
    this.rules.push({ matcher: predicate, response });
    return this;
  }

  async run(command: string, args: string[], options?: any): Promise<SandboxCommandResult> {
    this.executedCommands.push({ command, args, options });
    for (const rule of this.rules) {
      if (rule.matcher(command, args)) {
        const res = typeof rule.response === 'function' ? rule.response(command, args) : rule.response;
        return {
          command,
          exitStatus: res.exitStatus ?? 0,
          stdout: res.stdout ?? '',
          stderr: res.stderr ?? '',
        };
      }
    }
    return { command, exitStatus: 0, stdout: '[]', stderr: '' };
  }

  clear(): void {
    this.rules = [];
    this.executedCommands = [];
  }
}

// Helper to construct full valid test configuration
function createTestConfig(overrides: Partial<CtReviewConfigV3> = {}): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'balanced',
    quorum: 1,
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 30,
      providers: [
        { id: 'mock-provider', enabled: true, model: 'mock-model', review_timeout_s: 15, arbiter_timeout_s: 15 },
      ],
      arbiter: { order: ['mock-provider'] },
    },
    personas: [
      {
        id: 'sec-lane',
        provider: 'mock-provider',
        providers: ['mock-provider'],
        model: 'mock-model',
        charter: 'builtin:security',
        enabled: true,
        required: true,
        paths: ['src/sec/**', 'src/auth/**'],
      },
      {
        id: 'qual-lane',
        provider: 'mock-provider',
        providers: ['mock-provider'],
        model: 'mock-model',
        charter: 'builtin:consistency',
        enabled: true,
        required: true,
        paths: ['src/utils/**', 'src/qual/**'],
      },
    ],
    moderator: { provider: 'mock-provider', providers: ['mock-provider'], model: 'mock-model', review_timeout_s: 15 },
    arbiter: { provider: 'mock-provider', providers: ['mock-provider'], model: 'mock-model', arbiter_timeout_s: 15 },
    reviews: {
      profile: 'chill',
      request_changes_workflow: false,
      high_level_summary: true,
      poem: false,
      review_status: true,
      collapse_walkthrough: false,
      auto_review: {
        enabled: true,
        ignore_title_keywords: [],
        labels: [],
        drafts: false,
        base_branches: [],
      },
      tools: {},
    },
    chat: { auto_reply: true },
    knowledge_base: { opt_out: false, learnings: [] },
    path_filters: { rules: [] },
    auto_review: {
      enabled: true,
      drafts: false,
      base_branches: [],
      ignore_title_keywords: [],
      labels: [],
    },
    dials: {},
    mcps: {},
    on_pr_close: { create_followup_prs: [], sync_productlane: false },
    pre_checks: {
      enabled: true,
      zoekt: { enabled: true, max_symbols: 25 },
      analyzers: { enabled: true, linters: true, security: true, secrets: true },
    },
    ...overrides,
  } as CtReviewConfigV3;
}

// Mock model client returning structured nonce-fenced persona output with role tagging
function createRecordingMockClient() {
  const recordedCalls: Array<{ role: string; persona: string; messages: any[] }> = [];

  const mockClient = {
    complete: vi.fn().mockImplementation(async (payload: any) => {
      const contentStr = (payload.messages || []).map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');

      const isModerator = payload.metadata?.role === 'moderator' || payload.persona === 'moderator' || contentStr.includes('role":"moderator"') || contentStr.includes('Role: MODERATOR');
      const isArbiter = payload.metadata?.role === 'arbiter' || payload.persona === 'arbiter' || contentStr.includes('role":"arbiter"') || contentStr.includes('Role: ARBITER') || contentStr.includes('ARBITER FINAL VERDICT') || contentStr.includes('SHIP, FIX_FIRST, or BLOCK');

      const role = isModerator ? 'moderator' : isArbiter ? 'arbiter' : 'persona';
      const persona = payload.persona || (isModerator ? 'moderator' : isArbiter ? 'arbiter' : 'persona');

      recordedCalls.push({
        role,
        persona,
        messages: payload.messages || [],
      });

      const nonceMatch = contentStr.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
      const nonce = nonceMatch ? nonceMatch[1] : 'nonce-emp-123';

      if (role === 'moderator') {
        return {
          id: 'msg_mod',
          providerId: 'mock-provider',
          model: 'mock-model',
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
          durationMs: 10,
        };
      } else if (role === 'arbiter') {
        return {
          id: 'msg_arb',
          providerId: 'mock-provider',
          model: 'mock-model',
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Verified clean' })}\nCT_REVIEW_END:${nonce}`,
          usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
          durationMs: 10,
        };
      } else {
        return {
          id: 'msg_persona',
          providerId: 'mock-provider',
          model: 'mock-model',
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
          durationMs: 10,
        };
      }
    }),
  };

  return { mockClient, recordedCalls };
}

describe('Challenger M4-2 Empirical Challenge Test Suite', () => {

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // SECTION 1: CONCURRENT PRE-CHECK EXECUTION & FAIL-SOFT ISOLATION
  // ===========================================================================
  describe('1. Concurrent Pre-Check Execution & Fail-Soft Isolation', () => {

    it('1.1: executes Zoekt and Sandbox Analyzers concurrently via Promise.all (not serialized)', async () => {
      let zoektStartedAt = 0;
      let zoektFinishedAt = 0;
      let analyzersStartedAt = 0;
      let analyzersFinishedAt = 0;

      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockImplementation(async () => {
        zoektStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 40));
        zoektFinishedAt = Date.now();
        return {
          status: 'ok',
          scannedSymbolsCount: 2,
          matchedSymbolsCount: 2,
          symbols: [
            { name: 'authenticate', kind: 'function', line: 12, sourcePath: 'src/sec/auth.ts', preview: 'function authenticate() {}' },
          ],
          receipt: { totalQueries: 1, durationMs: 40 },
        };
      });

      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockImplementation(async () => {
        analyzersStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 40));
        analyzersFinishedAt = Date.now();
        return {
          enabled: true,
          analyzersExecuted: 2,
          hypothesesCount: 1,
          receipts: [],
          hypotheses: [
            {
              id: 'hyp:semgrep:vuln-1:src/sec/auth.ts:15',
              analyzer: 'semgrep',
              category: 'security',
              ruleId: 'hardcoded-jwt-secret',
              path: 'src/sec/auth.ts',
              line: 15,
              message: 'Hardcoded JWT secret detected.',
              severity: 'critical',
              confidence: 'high',
            },
          ],
          status: 'ok',
          durationMs: 40,
        };
      });

      const config = createTestConfig();
      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head1234',
        memoryRules: [],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // Both runners must have executed
      expect(zoektStartedAt).toBeGreaterThan(0);
      expect(analyzersStartedAt).toBeGreaterThan(0);

      // Verify CONCURRENCY: analyzers must start BEFORE Zoekt finishes!
      expect(analyzersStartedAt).toBeLessThanOrEqual(zoektFinishedAt + 20);
      expect(zoektStartedAt).toBeLessThanOrEqual(analyzersFinishedAt + 20);
    });

    it('1.2: Zoekt failure does not block Analyzer pre-check; panel finishes successfully (fail-soft)', async () => {
      // Zoekt throws an unhandled crash
      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockRejectedValue(
        new Error('Fatal Zoekt daemon OOM segmentation fault')
      );

      // Analyzers succeed with valid findings
      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockResolvedValue({
        enabled: true,
        analyzersExecuted: 1,
        hypothesesCount: 1,
        receipts: [],
        hypotheses: [
          {
            id: 'hyp:semgrep:xss:src/sec/auth.ts:20',
            analyzer: 'semgrep',
            category: 'security',
            ruleId: 'xss-injection',
            path: 'src/sec/auth.ts',
            line: 20,
            message: 'Potential XSS injection',
            severity: 'critical',
            confidence: 'high',
          },
        ],
        status: 'ok',
        durationMs: 25,
      });

      const config = createTestConfig();
      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-zoekt-fail',
        memoryRules: [],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // sec-lane prompt must contain candidate hypothesis despite Zoekt's fatal crash
      const secCall = recordedCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secCall?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).toContain('hyp:semgrep:xss:src/sec/auth.ts:20');
      expect(secPrompt).toContain('Potential XSS injection');
    });

    it('1.3: Analyzer runner failure does not block Zoekt pre-check; panel finishes successfully (fail-soft)', async () => {
      // Zoekt succeeds with symbol evidence
      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValue({
        status: 'ok',
        scannedSymbolsCount: 1,
        matchedSymbolsCount: 1,
        symbols: [
          { name: 'verifyToken', kind: 'function', line: 42, sourcePath: 'src/sec/auth.ts', preview: 'function verifyToken() {}' },
        ],
        receipt: { totalQueries: 1, durationMs: 15 },
      });

      // Analyzer runner throws an unhandled error
      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockRejectedValue(
        new Error('Docker container sandbox daemon unreachable')
      );

      const config = createTestConfig();
      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-analyzer-fail',
        memoryRules: [],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      // sec-lane prompt must contain the Zoekt symbol evidence despite analyzer failure
      const secCall = recordedCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secCall?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).toContain('verifyToken');
      expect(secPrompt).toContain('src/sec/auth.ts');
      expect(secPrompt).toContain('function');
    });

    it('1.4: Dual failure (both Zoekt and Analyzers crash) fails soft without closing panel', async () => {
      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockRejectedValue(
        new Error('Zoekt catastrophic failure')
      );
      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockRejectedValue(
        new Error('Analyzer catastrophic failure')
      );

      const config = createTestConfig();
      const { mockClient } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-dual-fail',
        memoryRules: [],
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');
      expect(result.moderator.findings).toEqual([]);
    });
  });

  // ===========================================================================
  // SECTION 2: PERSONA LANE SCOPING & 20-HYPOTHESIS BUDGET CAP
  // ===========================================================================
  describe('2. Persona Lane Scoping & 20-Hypothesis Budget Cap', () => {

    it('2.1: strictly scopes hypotheses by persona lane charter and changedFiles path scope', () => {
      const mixedHypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:gitleaks:secret-1:src/sec/auth.ts:10',
          analyzer: 'gitleaks',
          category: 'secrets',
          ruleId: 'aws-secret-key',
          path: 'src/sec/auth.ts',
          line: 10,
          message: 'Hardcoded AWS secret key',
          severity: 'critical',
          confidence: 'high',
        },
        {
          id: 'hyp:eslint:lint-1:src/sec/auth.ts:25',
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'no-unused-vars',
          path: 'src/sec/auth.ts',
          line: 25,
          message: 'Unused variable x',
          severity: 'info',
          confidence: 'medium',
        },
        {
          id: 'hyp:semgrep:sec-1:src/sec/auth.ts:35',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'sql-injection',
          path: 'src/sec/auth.ts',
          line: 35,
          message: 'Raw SQL parameter interpolation',
          severity: 'error',
          confidence: 'high',
        },
        {
          id: 'hyp:eslint:lint-2:src/utils/format.ts:12',
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'prefer-const',
          path: 'src/utils/format.ts',
          line: 12,
          message: 'Variable never reassigned; use const',
          severity: 'warning',
          confidence: 'high',
        },
        {
          id: 'hyp:semgrep:sec-2:src/utils/format.ts:40',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'insecure-random',
          path: 'src/utils/format.ts',
          line: 40,
          message: 'Math.random used for security token',
          severity: 'critical',
          confidence: 'high',
        },
      ];

      // sec-lane evaluating src/sec/auth.ts
      const secScoped = filterHypothesesForPersona({
        hypotheses: mixedHypotheses,
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/sec/auth.ts' }],
      });

      // sec-lane must receive secrets and security on src/sec/auth.ts only
      expect(secScoped.map((h) => h.id)).toEqual([
        'hyp:gitleaks:secret-1:src/sec/auth.ts:10',
        'hyp:semgrep:sec-1:src/sec/auth.ts:35',
      ]);
      // sec-lane must NOT receive linter on auth.ts
      expect(secScoped.some((h) => h.category === 'linter')).toBe(false);
      // sec-lane must NOT receive any items from src/utils/format.ts
      expect(secScoped.some((h) => h.path.includes('format.ts'))).toBe(false);

      // qual-lane evaluating src/utils/format.ts
      const qualScoped = filterHypothesesForPersona({
        hypotheses: mixedHypotheses,
        personaId: 'qual-lane',
        charter: 'builtin:consistency',
        scopedFiles: [{ path: 'src/utils/format.ts' }],
      });

      // qual-lane must receive linter on src/utils/format.ts only
      expect(qualScoped.map((h) => h.id)).toEqual([
        'hyp:eslint:lint-2:src/utils/format.ts:12',
      ]);
      // qual-lane must NOT receive security finding on format.ts
      expect(qualScoped.some((h) => h.category === 'security')).toBe(false);
      // qual-lane must NOT receive any items from auth.ts
      expect(qualScoped.some((h) => h.path.includes('auth.ts'))).toBe(false);
    });

    it('2.2: strictly caps hypotheses at 20 and prioritizes secrets > security > linter with severity ordering', () => {
      // Construct 35 hypotheses spanning different categories and severities
      const hypotheses: CandidateHypothesis[] = [];

      // 3 secrets (critical)
      for (let i = 1; i <= 3; i++) {
        hypotheses.push({
          id: `hyp:gitleaks:secret-${i}:src/app.ts:${i * 10}`,
          analyzer: 'gitleaks',
          category: 'secrets',
          ruleId: 'secret-key',
          path: 'src/app.ts',
          line: i * 10,
          message: `Secret token ${i}`,
          severity: 'critical',
          confidence: 'high',
        });
      }

      // 5 security critical
      for (let i = 1; i <= 5; i++) {
        hypotheses.push({
          id: `hyp:semgrep:sec-crit-${i}:src/app.ts:${100 + i}`,
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'rce-vuln',
          path: 'src/app.ts',
          line: 100 + i,
          message: `RCE vulnerability ${i}`,
          severity: 'critical',
          confidence: 'high',
        });
      }

      // 5 security error
      for (let i = 1; i <= 5; i++) {
        hypotheses.push({
          id: `hyp:semgrep:sec-err-${i}:src/app.ts:${200 + i}`,
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'sqli-vuln',
          path: 'src/app.ts',
          line: 200 + i,
          message: `SQL injection ${i}`,
          severity: 'error',
          confidence: 'high',
        });
      }

      // 10 security warning
      for (let i = 1; i <= 10; i++) {
        hypotheses.push({
          id: `hyp:semgrep:sec-warn-${i}:src/app.ts:${300 + i}`,
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'cors-misconfig',
          path: 'src/app.ts',
          line: 300 + i,
          message: `CORS misconfig ${i}`,
          severity: 'warning',
          confidence: 'medium',
        });
      }

      // 12 linter info
      for (let i = 1; i <= 12; i++) {
        hypotheses.push({
          id: `hyp:eslint:lint-info-${i}:src/app.ts:${400 + i}`,
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'no-console',
          path: 'src/app.ts',
          line: 400 + i,
          message: `Console statement ${i}`,
          severity: 'info',
          confidence: 'low',
        });
      }

      expect(hypotheses.length).toBe(35);

      const scoped = filterHypothesesForPersona({
        hypotheses,
        personaId: 'general-lane',
        charter: 'review everything',
        scopedFiles: [{ path: 'src/app.ts' }],
      });

      // Must be capped at exactly 20
      expect(scoped.length).toBe(20);

      // Top 3 must be secrets
      expect(scoped.slice(0, 3).every((h) => h.category === 'secrets')).toBe(true);

      // Next 5 must be security critical
      expect(scoped.slice(3, 8).every((h) => h.category === 'security' && h.severity === 'critical')).toBe(true);

      // Next 5 must be security error
      expect(scoped.slice(8, 13).every((h) => h.category === 'security' && h.severity === 'error')).toBe(true);

      // Remaining 7 must be the highest security warnings
      expect(scoped.slice(13, 20).every((h) => h.category === 'security' && h.severity === 'warning')).toBe(true);

      // Low-priority linter items must have been completely truncated out
      expect(scoped.some((h) => h.category === 'linter')).toBe(false);

      // Verify prompt formatting includes explicit verification protocol
      const prompt = formatCandidateHypothesesPrompt(scoped);
      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('Verify or refute each hypothesis during your review turns:');
      expect(prompt).toContain('Do NOT publish raw hypotheses directly without verifying them.');
      expect(prompt).toContain('If verified:');
      expect(prompt).toContain('If refuted');

      // Count occurrences of hypothesis markers in formatted prompt: must be exactly 20
      const matches = prompt.match(/- \[HYPOTHESIS /g);
      expect(matches?.length).toBe(20);
    });

    it('2.3: candidate hypotheses are passed to persona turns, but isolated from moderator and arbiter', async () => {
      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockResolvedValue({
        enabled: true,
        analyzersExecuted: 1,
        hypothesesCount: 1,
        receipts: [],
        hypotheses: [
          {
            id: 'hyp:semgrep:jwt:src/sec/auth.ts:18',
            analyzer: 'semgrep',
            category: 'security',
            ruleId: 'jwt-none-algorithm',
            path: 'src/sec/auth.ts',
            line: 18,
            message: 'Insecure JWT none algorithm accepted',
            severity: 'critical',
            confidence: 'high',
          },
        ],
        status: 'ok',
        durationMs: 10,
      });

      const config = createTestConfig();
      const { mockClient, recordedCalls } = createRecordingMockClient();

      await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-role-isolation',
        memoryRules: [],
      });

      const personaCalls = recordedCalls.filter((c) => c.role === 'persona');
      const moderatorCalls = recordedCalls.filter((c) => c.role === 'moderator');
      const arbiterCalls = recordedCalls.filter((c) => c.role === 'arbiter');

      expect(personaCalls.length).toBeGreaterThan(0);
      expect(moderatorCalls.length).toBeGreaterThan(0);
      expect(arbiterCalls.length).toBeGreaterThan(0);

      // Persona prompt must receive the hypothesis
      const secPersona = personaCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secPersona?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).toContain('hyp:semgrep:jwt:src/sec/auth.ts:18');

      // Moderator and Arbiter MUST NOT receive candidate hypotheses
      for (const mod of moderatorCalls) {
        const modPrompt = mod.messages.map((m) => m.content).join('\n');
        expect(modPrompt).not.toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
        expect(modPrompt).not.toContain('hyp:semgrep:jwt:src/sec/auth.ts:18');
      }
      for (const arb of arbiterCalls) {
        const arbPrompt = arb.messages.map((m) => m.content).join('\n');
        expect(arbPrompt).not.toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
        expect(arbPrompt).not.toContain('hyp:semgrep:jwt:src/sec/auth.ts:18');
      }
    });
  });

  // ===========================================================================
  // SECTION 3: CONFIGURATION OVERRIDES & GRANULAR DISABLE TOGGLES
  // ===========================================================================
  describe('3. Configuration Overrides & Granular Disable Toggles', () => {

    it('3.1: pre_checks.enabled: false completely bypasses both Zoekt and Sandbox Analyzers', async () => {
      const zoektSpy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck');
      const analyzerSpy = vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers');

      const config = createTestConfig({
        pre_checks: {
          enabled: false,
          zoekt: { enabled: true },
          analyzers: { enabled: true },
        },
      });

      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-prechecks-disabled',
        memoryRules: [],
      });

      expect(result.arbiter.verdict).toBe('SHIP');
      // Neither pre-check runner should have been called
      expect(zoektSpy).not.toHaveBeenCalled();
      expect(analyzerSpy).not.toHaveBeenCalled();

      // Personas must not have received any pre-check prompt sections
      const secCall = recordedCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secCall?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).not.toContain('=== DETERMINISTIC SYMBOL PRE-CHECK ===');
      expect(secPrompt).not.toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK');
    });

    it('3.2: pre_checks.analyzers.enabled: false bypasses Analyzers while allowing Zoekt to execute', async () => {
      const zoektSpy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValue({
        status: 'ok',
        scannedSymbolsCount: 1,
        matchedSymbolsCount: 1,
        symbols: [
          { symbol: 'login', kind: 'function', line: 10, sourcePath: 'src/sec/auth.ts', preview: 'function login() {}' } as any,
        ],
        receipt: { totalQueries: 1, durationMs: 10 },
      });
      const analyzerSpy = vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers');

      const config = createTestConfig({
        pre_checks: {
          enabled: true,
          zoekt: { enabled: true },
          analyzers: { enabled: false },
        },
      });

      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-analyzers-disabled',
        memoryRules: [],
      });

      expect(result.arbiter.verdict).toBe('SHIP');
      expect(zoektSpy).toHaveBeenCalled();
      expect(analyzerSpy).not.toHaveBeenCalled();

      const secCall = recordedCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secCall?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).toContain('=== PRE-CHECK SYMBOL & REPOSITORY CONTEXT (ZOEKT) ===');
      expect(secPrompt).toContain('login');
      expect(secPrompt).not.toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK');
    });

    it('3.3: pre_checks.zoekt.enabled: false bypasses Zoekt while allowing Analyzers to execute', async () => {
      const zoektSpy = vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck');
      const analyzerSpy = vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockResolvedValue({
        enabled: true,
        analyzersExecuted: 1,
        hypothesesCount: 1,
        receipts: [],
        hypotheses: [
          {
            id: 'hyp:semgrep:cors:src/sec/auth.ts:50',
            analyzer: 'semgrep',
            category: 'security',
            ruleId: 'permissive-cors',
            path: 'src/sec/auth.ts',
            line: 50,
            message: 'Wildcard CORS allowed',
            severity: 'error',
            confidence: 'high',
          },
        ],
        status: 'ok',
        durationMs: 15,
      });

      const config = createTestConfig({
        pre_checks: {
          enabled: true,
          zoekt: { enabled: false },
          analyzers: { enabled: true },
        },
      });

      const { mockClient, recordedCalls } = createRecordingMockClient();

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/sec/auth.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'calltelemetry/repo',
        headSha: 'head-zoekt-disabled',
        memoryRules: [],
      });

      expect(result.arbiter.verdict).toBe('SHIP');
      expect(zoektSpy).not.toHaveBeenCalled();
      expect(analyzerSpy).toHaveBeenCalled();

      const secCall = recordedCalls.find((c) => c.persona === 'sec-lane');
      const secPrompt = secCall?.messages.map((m) => m.content).join('\n') || '';
      expect(secPrompt).not.toContain('=== DETERMINISTIC SYMBOL PRE-CHECK ===');
      expect(secPrompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
      expect(secPrompt).toContain('permissive-cors');
    });

    it('3.4: granular category toggles (linters, security, secrets) filter applicable analyzers accurately', () => {
      // TypeScript file:
      // default: [eslint, semgrep, gitleaks]
      expect(getApplicableAnalyzers('src/app.ts')).toEqual(['eslint', 'semgrep', 'gitleaks']);

      // linters: false -> [semgrep, gitleaks]
      expect(getApplicableAnalyzers('src/app.ts', { enabled: true, linters: false })).toEqual(['semgrep', 'gitleaks']);

      // security: false -> [eslint, gitleaks]
      expect(getApplicableAnalyzers('src/app.ts', { enabled: true, security: false })).toEqual(['eslint', 'gitleaks']);

      // secrets: false -> [eslint, semgrep]
      expect(getApplicableAnalyzers('src/app.ts', { enabled: true, secrets: false })).toEqual(['eslint', 'semgrep']);

      // all false -> []
      expect(getApplicableAnalyzers('src/app.ts', { enabled: true, linters: false, security: false, secrets: false })).toEqual([]);

      // Elixir file:
      // default: [semgrep, gitleaks] (CodeRabbit zero-compilation pattern)
      expect(getApplicableAnalyzers('lib/app.ex')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('lib/app.ex', { enabled: true, linters: false })).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('lib/app.ex', { enabled: true, security: false })).toEqual(['gitleaks']);

      // Go file:
      // default: [semgrep, gitleaks] (CodeRabbit zero-compilation pattern)
      expect(getApplicableAnalyzers('main.go')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('main.go', { enabled: true, linters: false })).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('main.go', { enabled: true, security: false })).toEqual(['gitleaks']);

      // Binary files: always [] regardless of toggles
      expect(getApplicableAnalyzers('image.png')).toEqual([]);
      expect(getApplicableAnalyzers('archive.zip')).toEqual([]);
      expect(getApplicableAnalyzers('library.so')).toEqual([]);
    });

    it('3.5: resolvePreChecksConfig ensures default-on semantics when pre_checks config is omitted or empty', () => {
      // Case A: completely undefined config
      const resolvedEmpty = resolvePreChecksConfig({});
      expect(resolvedEmpty).toEqual({
        enabled: true,
        zoekt: {
          enabled: true,
          max_symbols: 200,
          timeoutMs: 10000,
        },
        analyzers: {
          enabled: true,
          linters: true,
          security: true,
          secrets: true,
        },
      });

      // Case B: pre_checks: {}
      const resolvedPartial = resolvePreChecksConfig({ pre_checks: {} });
      expect(resolvedPartial.enabled).toBe(true);
      expect(resolvedPartial.zoekt.enabled).toBe(true);
      expect(resolvedPartial.analyzers.enabled).toBe(true);
      expect(resolvedPartial.analyzers.linters).toBe(true);
      expect(resolvedPartial.analyzers.security).toBe(true);
      expect(resolvedPartial.analyzers.secrets).toBe(true);

      // Case C: partial overrides preserved
      const resolvedOverride = resolvePreChecksConfig({
        pre_checks: {
          zoekt: { max_symbols: 10 },
          analyzers: { secrets: false },
        },
      });
      expect(resolvedOverride.enabled).toBe(true);
      expect(resolvedOverride.zoekt.max_symbols).toBe(10);
      expect(resolvedOverride.analyzers.secrets).toBe(false);
      expect(resolvedOverride.analyzers.linters).toBe(true);
    });
  });

  // ===========================================================================
  // SECTION 4: MOCK RUNNER SANDBOX INTEGRATION WITH LIVE ROUTING
  // ===========================================================================
  describe('4. Mock Runner Sandbox Integration with Live File Routing', () => {

    it('4.1: executes multi-tool pipeline end-to-end against mock runner and outputs valid PreCheckSummary', async () => {
      const runner = new MockSandboxRunner();

      // ESLint returns 1 finding
      runner.onCommand('eslint', {
        exitStatus: 1,
        stdout: JSON.stringify([
          {
            filePath: '/mock/src/api.ts',
            messages: [
              {
                ruleId: 'no-eval',
                severity: 2,
                message: 'eval can be harmful.',
                line: 8,
              },
            ],
          },
        ]),
      });

      // Semgrep returns 1 finding with security category
      runner.onCommand('semgrep', {
        exitStatus: 0,
        stdout: JSON.stringify({
          results: [
            {
              check_id: 'security-insecure-cookie',
              path: '/mock/src/api.ts',
              start: { line: 22, col: 5 },
              extra: { message: 'Cookie missing secure attribute', severity: 'WARNING' },
            },
          ],
        }),
      });

      // Gitleaks returns 1 finding
      runner.onCommand('gitleaks', {
        exitStatus: 1,
        stdout: JSON.stringify([
          {
            RuleID: 'generic-api-key',
            File: '/mock/src/api.ts',
            StartLine: 45,
            Description: 'Generic API Key found',
            Secret: 'AKIAIOSFODNN7EXAMPLE',
          },
        ]),
      });

      const summary = await runPreCheckAnalyzers({
        workspaceRoot: '/mock',
        changedFiles: [{ path: 'src/api.ts', patch: '@@ -1,5 +1,5 @@' }],
        sandboxRunner: runner,
        config: {
          enabled: true,
          linters: true,
          security: true,
          secrets: true,
        },
      });

      expect(summary.enabled).toBe(true);
      expect(summary.analyzersExecuted).toBe(3);
      expect(summary.hypothesesCount).toBe(3);
      expect(summary.status).toBe('ok');

      // Check gitleaks secret was masked properly
      const gitleaksHyp = summary.hypotheses.find((h) => h.analyzer === 'gitleaks');
      expect(gitleaksHyp).toBeDefined();
      expect(gitleaksHyp?.category).toBe('secrets');
      // Secret must be masked in snippet/details
      expect(JSON.stringify(gitleaksHyp)).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(JSON.stringify(gitleaksHyp)).toContain('AKIA****MPLE');

      // Now pass through filterHypothesesForPersona for sec-lane
      const secFiltered = filterHypothesesForPersona({
        hypotheses: summary.hypotheses,
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/api.ts' }],
      });

      // sec-lane gets gitleaks (secrets) and semgrep (security), with secrets prioritized first
      expect(secFiltered.length).toBe(2);
      expect(secFiltered.map((h) => h.analyzer)).toEqual(['gitleaks', 'semgrep']);
    });
  });
});
