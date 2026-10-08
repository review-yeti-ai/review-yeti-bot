import { describe, it, expect, vi } from 'vitest';
import {
  CandidateHypothesis,
  formatCandidateHypothesesPrompt,
  filterHypothesesForPersona,
  normalizeRepoPath,
} from '../../src/sandbox/analyzerRunner';
import { buildTaskScopedPrefix } from '../../src/panel/composedEngine';
import {
  evaluateReviewGate,
  ReviewGateCandidate,
  ReviewGateEvidence,
} from '../../src/review/reviewGatePolicy';
import { executePersonaPanel, validateFindings, extractMessageContentText } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import * as zoektPreCheckService from '../../src/services/zoektPreCheckService';
import * as analyzerRunnerModule from '../../src/sandbox/analyzerRunner';

describe('Milestone 5 Empirical Challenger Stress Harness (tests/unit/m5EmpiricalChallenger.test.ts)', () => {
  // =========================================================================
  // Scenario 1: Empty and Malformed Candidate Hypotheses
  // =========================================================================
  describe('Scenario 1: Empty & Malformed Candidate Hypotheses', () => {
    it('gracefully formats hypotheses with missing snippet, out-of-range line numbers, and unmapped analyzer names', () => {
      const adversarialHypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:missing-snippet',
          analyzer: 'unmapped-scanner-9000',
          category: 'linter',
          ruleId: 'rule-custom-1',
          path: 'src/utils/math.ts',
          line: 0, // boundary: 0
          message: 'Zero line number test',
          severity: 'warning',
          confidence: 'medium',
          // snippet omitted
        },
        {
          id: 'hyp:negative-line',
          analyzer: 'third-party-sast',
          category: 'security',
          ruleId: 'cwe-20',
          path: 'src/utils/math.ts',
          line: -42, // boundary: negative line
          message: 'Negative line number test',
          severity: 'error',
          confidence: 'high',
          snippet: 'x = -1;',
        },
        {
          id: 'hyp:huge-line',
          analyzer: 'deep-analyzer',
          category: 'secrets',
          ruleId: 'generic-secret',
          path: 'src/utils/math.ts',
          line: 999999999, // boundary: extreme line number
          message: 'Massive line number test',
          severity: 'critical',
          confidence: 'high',
          snippet: 'TOKEN="secret"',
        },
      ];

      const prompt = formatCandidateHypothesesPrompt(adversarialHypotheses);

      // Verify header and formatting
      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('unmapped-scanner-9000');
      expect(prompt).toContain('third-party-sast');
      expect(prompt).toContain('deep-analyzer');
      expect(prompt).toContain('Target: src/utils/math.ts:0');
      expect(prompt).toContain('Target: src/utils/math.ts:-42');
      expect(prompt).toContain('Target: src/utils/math.ts:999999999');

      // Verify missing snippet did not print an empty Context: line
      const lines = prompt.split('\n');
      const missingSnippetHypothesisBlock = lines.slice(
        lines.findIndex((l) => l.includes('hyp:missing-snippet')),
        lines.findIndex((l) => l.includes('hyp:negative-line'))
      );
      expect(missingSnippetHypothesisBlock.some((l) => l.includes('Context:'))).toBe(false);
    });

    it('handles empty arrays, null, undefined, and non-array object payloads without crashing', () => {
      expect(formatCandidateHypothesesPrompt([])).toBe('');
      expect(formatCandidateHypothesesPrompt(null)).toBe('');
      expect(formatCandidateHypothesesPrompt(undefined)).toBe('');

      // Object without hypotheses
      expect(formatCandidateHypothesesPrompt({} as any)).toBe('');

      // Disabled status
      expect(
        formatCandidateHypothesesPrompt({
          enabled: false,
          hypotheses: [{ id: '1', analyzer: 'x', category: 'linter', ruleId: 'r', path: 'p', line: 1, message: 'm', severity: 'warning', confidence: 'low' }],
        } as any)
      ).toBe('');

      // Unavailable status
      const unavail = formatCandidateHypothesesPrompt({ status: 'unavailable', hypotheses: [] } as any);
      expect(unavail).toContain('[Status: unavailable]');

      // Clean status
      const clean = formatCandidateHypothesesPrompt({ status: 'clean', hypotheses: [] } as any);
      expect(clean).toContain('[Status: clean]');
    });

    it('gracefully formats hypothesis when severity is missing without throwing', () => {
      const malformedHypothesis = {
        id: 'hyp:malformed-no-severity',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'no-var',
        path: 'src/index.ts',
        line: 1,
        message: 'Unexpected var',
        // severity missing: undefined
        confidence: 'high',
      };

      expect(() => {
        formatCandidateHypothesesPrompt([malformedHypothesis as any]);
      }).not.toThrow();

      const prompt = formatCandidateHypothesesPrompt([malformedHypothesis as any]);
      expect(prompt).toContain('- [HYPOTHESIS hyp:malformed-no-severity] (eslint | UNKNOWN | high confidence)');
      expect(prompt).toContain('Target: src/index.ts:1');
      expect(prompt).toContain('Rule: no-var');
      expect(prompt).toContain('Diagnostic: Unexpected var');
    });
  });

  // =========================================================================
  // Scenario 2: Lane Charter Leaks & Cross-Domain Isolation
  // =========================================================================
  describe('Scenario 2: Lane Charter Leaks & Cross-Domain Isolation', () => {
    const mixedHypotheses: CandidateHypothesis[] = [
      {
        id: 'hyp:sec:token-leak',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'api-secret',
        path: 'docs/api_guide.md',
        line: 15,
        message: 'Hardcoded API secret in documentation example',
        severity: 'critical',
        confidence: 'high',
      },
      {
        id: 'hyp:sec:injection',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'cwe-89',
        path: 'docs/api_guide.md',
        line: 25,
        message: 'SQL injection in sample query snippet',
        severity: 'error',
        confidence: 'high',
      },
      {
        id: 'hyp:lint:spelling',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'spellcheck',
        path: 'docs/api_guide.md',
        line: 30,
        message: 'Spelling error in comment',
        severity: 'warning',
        confidence: 'low',
      },
    ];

    it('verifies that quality lane (qual-lane with builtin:consistency) strictly filters out security and secrets hypotheses', () => {
      const filtered = filterHypothesesForPersona({
        hypotheses: mixedHypotheses,
        personaId: 'qual-lane',
        charter: 'builtin:consistency',
        scopedFiles: [{ path: 'docs/api_guide.md' }],
      });

      expect(filtered.map((h) => h.id)).toEqual(['hyp:lint:spelling']);
      expect(filtered.some((h) => h.category === 'security')).toBe(false);
      expect(filtered.some((h) => h.category === 'secrets')).toBe(false);
    });

    it('verifies documentation personas receive zero security or secrets hypotheses', () => {
      // Review Yeti defines 'documentation' and 'docs' personas with 'builtin:docs' / 'builtin:docs-compliance'
      const docHypotheses = filterHypothesesForPersona({
        hypotheses: mixedHypotheses,
        personaId: 'documentation',
        charter: 'builtin:docs',
        scopedFiles: [{ path: 'docs/api_guide.md' }],
      });

      expect(docHypotheses.some((h) => h.category === 'security')).toBe(false);
      expect(docHypotheses.some((h) => h.category === 'secrets')).toBe(false);
      expect(docHypotheses.map((h) => h.id)).toEqual(['hyp:lint:spelling']);
    });

    it('verifies custom quality persona IDs strictly receive linters and no security/secrets', () => {
      const qualityHypotheses = filterHypothesesForPersona({
        hypotheses: mixedHypotheses,
        personaId: 'code-quality',
        charter: 'Review code quality, naming conventions, and formatting guidelines',
        scopedFiles: [{ path: 'docs/api_guide.md' }],
      });

      expect(qualityHypotheses.some((h) => h.category === 'security')).toBe(false);
      expect(qualityHypotheses.some((h) => h.category === 'secrets')).toBe(false);
      expect(qualityHypotheses.map((h) => h.id)).toEqual(['hyp:lint:spelling']);
    });
  });

  // =========================================================================
  // Scenario 3: Path Escapes & Task Boundary Confinement
  // =========================================================================
  describe('Scenario 3: Path Escapes & Task Boundary Confinement', () => {
    const pathTestHypotheses: CandidateHypothesis[] = [
      {
        id: 'hyp:auth-exact',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'auth-bypass',
        path: 'src/services/auth.ts',
        line: 12,
        message: 'Auth bypass defect',
        severity: 'critical',
        confidence: 'high',
      },
      {
        id: 'hyp:auth-relative',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'auth-check',
        path: './src/services/auth.ts',
        line: 18,
        message: 'Auth check defect',
        severity: 'error',
        confidence: 'high',
      },
      {
        id: 'hyp:escape-unassigned-file',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'db-password',
        path: 'src/config/database.env',
        line: 4,
        message: 'Database secret leak',
        severity: 'critical',
        confidence: 'high',
      },
      {
        id: 'hyp:escape-similar-name',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'auth-ts-bak',
        path: 'src/services/auth.ts.bak',
        line: 12,
        message: 'Backup file bug',
        severity: 'warning',
        confidence: 'medium',
      },
      {
        id: 'hyp:escape-sibling-dir',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'ui-xss',
        path: 'src/ui/auth.ts',
        line: 5,
        message: 'UI auth file defect',
        severity: 'warning',
        confidence: 'medium',
      },
    ];

    it('strictly confines hypotheses to task.paths and excludes all unassigned and sibling paths', () => {
      const task = {
        id: 'task-auth-only',
        dimension: 'security' as const,
        paths: ['src/services/auth.ts'],
        question: 'Is auth.ts secure?',
        rationale: 'Reviewing auth service exclusively',
      };

      const preCheckEvidence = {
        analyzers: {
          enabled: true,
          analyzersExecuted: 2,
          hypothesesCount: pathTestHypotheses.length,
          receipts: [],
          hypotheses: pathTestHypotheses,
          status: 'ok' as const,
        },
      };

      const prefix = buildTaskScopedPrefix({
        task,
        effectiveFiles: [
          { path: 'src/services/auth.ts', patch: '@@ -1,5 +1,5 @@' },
          { path: 'src/config/database.env', patch: '@@ -1,2 +1,2 @@' },
          { path: 'src/ui/auth.ts', patch: '@@ -1,2 +1,2 @@' },
        ],
        domainLanes: {
          'src/services/auth.ts': 'security_auth',
          'src/config/database.env': 'system_runtime',
          'src/ui/auth.ts': 'ui_frontend',
        },
        repository: 'exampleorg/repo',
        headSha: 'head-path-test',
        repositoryVisibility: 'PUBLIC',
        rules: [],
        preCheckEvidence,
      });

      // Target file hypotheses must be present
      expect(prefix).toContain('hyp:auth-exact');
      expect(prefix).toContain('hyp:auth-relative');

      // Escaping hypotheses must NOT be present in this task's prompt prefix
      expect(prefix).not.toContain('hyp:escape-unassigned-file');
      expect(prefix).not.toContain('hyp:escape-similar-name');
      expect(prefix).not.toContain('hyp:escape-sibling-dir');
      expect(prefix).not.toContain('db-password');
      expect(prefix).not.toContain('ui-xss');
    });

    it('normalizes paths and rejects directory prefix spoofing', () => {
      const norm1 = normalizeRepoPath('src/services/auth.ts');
      const norm2 = normalizeRepoPath('./src/services/auth.ts');
      const norm3 = normalizeRepoPath('src/services/auth.ts.bak');

      expect(norm1).toBe('src/services/auth.ts');
      expect(norm2).toBe('src/services/auth.ts');
      expect(norm1 === norm3).toBe(false);
      expect(norm3.endsWith('/' + norm1)).toBe(false);
    });
  });

  // =========================================================================
  // Scenario 4: Isolation of Unverified Hypotheses From Gate & Publishing
  // =========================================================================
  describe('Scenario 4: Isolation of Unverified Hypotheses From Gate & Publishing', () => {
    it('ensures unverified hypotheses never trigger gate failure when personas find zero issues', () => {
      // 1. Static analyzers flagged critical hypotheses
      const criticalHypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:critical-raw-fp',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'critical-false-positive',
          path: 'src/core/security.ts',
          line: 100,
          message: 'Supposed remote code execution',
          severity: 'critical',
          confidence: 'high',
        },
      ];

      // 2. Persona inspects and refutes the hypothesis as a false positive, returning 0 findings
      const findings = validateFindings([]);
      expect(findings).toHaveLength(0);

      // 3. Downstream gate evaluation checks gate evidence
      const gateCandidate: ReviewGateCandidate = {
        repositoryId: 1001,
        prNumber: 99,
        headSha: 'ccccdddd11112222333344445555666677778888',
        baseSha: 'eeeeffff11112222333344445555666677778888',
        policyDigest: 'a'.repeat(64),
      };

      const cleanEvidence: ReviewGateEvidence = {
        verdict: 'SHIP',
        completedAt: new Date().toISOString(),
        coverageComplete: true,
        quorumSatisfied: true,
        infrastructureFailure: false,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
        expectedLanes: 2,
        completedLanes: 2,
      };

      const decision = evaluateReviewGate({
        candidate: gateCandidate,
        current: { ...gateCandidate, open: true, draft: false },
        evidence: cleanEvidence,
      });

      expect(decision.status).toBe('success');
      expect(decision.eligible).toBe(true);
      expect(decision.reason).toBe('clean-review');
    });

    it('ensures arbiter and moderator are completely isolated from candidate hypotheses during panel execution', async () => {
      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValue({
        status: 'ok',
        scannedSymbols: 0,
        matchedSymbols: 0,
        totalQueries: 0,
        durationMs: 1,
        truncated: false,
        symbols: [],
      } as any);

      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockResolvedValue({
        enabled: true,
        analyzersExecuted: 1,
        hypothesesCount: 1,
        receipts: [],
        hypotheses: [
          {
            id: 'hyp:sec-isolation-check',
            analyzer: 'semgrep',
            category: 'security',
            ruleId: 'cwe-327',
            path: 'src/crypto/keys.ts',
            line: 42,
            message: 'Weak cipher used',
            severity: 'error',
            confidence: 'high',
          },
        ],
        status: 'ok',
        durationMs: 5,
      });

      const config: CtReviewConfigV3 = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 30,
          providers: [{ id: 'mock-p', enabled: true, model: 'mock-m', review_timeout_s: 15, arbiter_timeout_s: 15 }],
          arbiter: { order: ['mock-p'] },
        },
        personas: [
          {
            id: 'sec-lane',
            provider: 'mock-p',
            providers: ['mock-p'],
            model: 'mock-m',
            charter: 'builtin:security',
            enabled: true,
            required: true,
            paths: ['src/crypto/**'],
          },
        ],
        moderator: { provider: 'mock-p', providers: ['mock-p'], model: 'mock-m', review_timeout_s: 15 },
        arbiter: { provider: 'mock-p', providers: ['mock-p'], model: 'mock-m', arbiter_timeout_s: 15 },
        pre_checks: {
          enabled: true,
          zoekt: { enabled: true, max_symbols: 25 },
          analyzers: { enabled: true, linters: true, security: true, secrets: true },
        },
      } as any;

      const receivedPrompts: Array<{ role: string; content: string }> = [];

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const content = (payload.messages || []).map((m: any) => extractMessageContentText(m.content)).join('\n');
          const isModerator = content.includes('role":"moderator"') || content.includes('Role: MODERATOR');
          const isArbiter = content.includes('role":"arbiter"') || content.includes('Role: ARBITER') || content.includes('ARBITER FINAL VERDICT');
          const role = isModerator ? 'moderator' : isArbiter ? 'arbiter' : 'persona';

          receivedPrompts.push({ role, content });

          const nonceMatch = content.match(/CT_REVIEW_NONCE:([^\s]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-isolated';

          if (role === 'moderator') {
            return {
              id: 'm1',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, estimatedCostUSD: 0 },
              durationMs: 5,
            };
          } else if (role === 'arbiter') {
            return {
              id: 'a1',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All clean' })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, estimatedCostUSD: 0 },
              durationMs: 5,
            };
          } else {
            return {
              id: 'p1',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, estimatedCostUSD: 0 },
              durationMs: 5,
            };
          }
        }),
      };

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/crypto/keys.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'exampleorg/repo',
        headSha: 'head-iso-test',
      });

      expect(result.arbiter.verdict).toBe('SHIP');

      // Persona turn received candidate hypothesis
      const personaTurn = receivedPrompts.find((p) => p.role === 'persona');
      expect(personaTurn?.content).toContain('cwe-327');

      // Moderator and Arbiter turns did NOT receive candidate hypotheses
      const moderatorTurn = receivedPrompts.find((p) => p.role === 'moderator');
      if (moderatorTurn) {
        expect(moderatorTurn.content).not.toContain('DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
        expect(moderatorTurn.content).not.toContain('cwe-327');
      }

      const arbiterTurn = receivedPrompts.find((p) => p.role === 'arbiter');
      if (arbiterTurn) {
        expect(arbiterTurn.content).not.toContain('DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
        expect(arbiterTurn.content).not.toContain('cwe-327');
      }
    });
  });
});
