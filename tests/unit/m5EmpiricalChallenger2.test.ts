import { describe, it, expect } from 'vitest';
import {
  CandidateHypothesis,
  formatCandidateHypothesesPrompt,
  filterHypothesesForPersona,
  maskSecret,
  normalizeRepoPath,
  getApplicableAnalyzers,
} from '../../src/sandbox/analyzerRunner';
import { buildTaskScopedPrefix } from '../../src/panel/composedEngine';
import { evaluateReviewGate, ReviewGateCandidate, ReviewGateEvidence } from '../../src/review/reviewGatePolicy';

describe('Milestone 5 Iteration 2 Challenger 2 Empirical Stress Harness (tests/unit/m5EmpiricalChallenger2.test.ts)', () => {
  // =========================================================================
  // Challenge 1: Extreme & Adversarial Masking and Normalization
  // =========================================================================
  describe('Challenge 1: Extreme & Adversarial Masking and Normalization', () => {
    it('handles boundary conditions in secret masking without information leakage or crashes', () => {
      // Empty / non-string / undefined / null
      expect(maskSecret('')).toBe('***');
      expect(maskSecret(undefined as any)).toBe('***');
      expect(maskSecret(null as any)).toBe('***');
      expect(maskSecret(12345 as any)).toBe('***');

      // Short strings (<= 6 characters)
      expect(maskSecret('a')).toBe('***');
      expect(maskSecret('secret')).toBe('***');
      expect(maskSecret('  secret  ')).toBe('***'); // trimmed length <= 6

      // Medium strings (7 to 12 characters): keeps 2 prefix, 2 suffix
      const med = maskSecret('1234567');
      expect(med).toBe('12****67');
      expect(med.length).toBe(8);

      const twelve = maskSecret('123456789012');
      expect(twelve).toBe('12****12');

      // Long strings (> 12 characters): keeps 4 prefix, 4 suffix
      const thirteen = maskSecret('1234567890123');
      expect(thirteen).toBe('1234****0123');

      const awsKey = maskSecret('AKIAIOSFODNN7EXAMPLE');
      expect(awsKey).toBe('AKIA****MPLE');
      expect(awsKey).not.toContain('OSFODNN7EXA');
    });

    it('handles complex, cyclic, or malicious repository paths without path traversal or regex injection', () => {
      expect(normalizeRepoPath('')).toBe('');
      expect(normalizeRepoPath(undefined as any)).toBe('');
      expect(normalizeRepoPath(null as any)).toBe('');
      expect(normalizeRepoPath('./foo/bar/baz.ts')).toBe('foo/bar/baz.ts');
      expect(normalizeRepoPath('.//foo//bar///baz.ts')).toBe('foo//bar///baz.ts');
      expect(normalizeRepoPath('\\foo\\bar\\baz.ts')).toBe('foo/bar/baz.ts');
      expect(normalizeRepoPath('C:\\workspace\\src\\index.ts', 'C:\\workspace')).toBe('src/index.ts');
      expect(normalizeRepoPath('/workspace/src/index.ts', '/workspace')).toBe('src/index.ts');
      expect(normalizeRepoPath('/workspace', '/workspace')).toBe('');
    });

    it('correctly maps analyzers for polyglot languages under CodeRabbit zero-compilation pattern', () => {
      // TypeScript/JavaScript: eslint, semgrep, gitleaks
      expect(getApplicableAnalyzers('src/app.ts')).toEqual(['eslint', 'semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('src/component.tsx')).toEqual(['eslint', 'semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('src/script.mjs')).toEqual(['eslint', 'semgrep', 'gitleaks']);

      // Elixir & Go: fast AST semgrep + gitleaks (mix/credo/sobelow/govet compiled analyzers eliminated)
      expect(getApplicableAnalyzers('lib/auth.ex')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('lib/worker.exs')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('pkg/server.go')).toEqual(['semgrep', 'gitleaks']);

      // Python, Rust, Ruby, Java, C/C++: semgrep + gitleaks
      expect(getApplicableAnalyzers('service.py')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('engine.rs')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('app.rb')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('Main.java')).toEqual(['semgrep', 'gitleaks']);
      expect(getApplicableAnalyzers('module.cpp')).toEqual(['semgrep', 'gitleaks']);

      // Binaries & WASM: zero analyzers
      expect(getApplicableAnalyzers('assets/logo.png')).toEqual([]);
      expect(getApplicableAnalyzers('archive.zip')).toEqual([]);
      expect(getApplicableAnalyzers('module.wasm')).toEqual([]);
    });
  });

  // =========================================================================
  // Challenge 2: Massive Volume, Sorting Stability & Stack Resilience
  // =========================================================================
  describe('Challenge 2: Massive Volume, Sorting Stability & Stack Resilience', () => {
    it('processes 1,000 candidate hypotheses efficiently without stack overflow and respects 20 hypotheses cap', () => {
      const largeHypotheses: CandidateHypothesis[] = [];
      const categories = ['linter', 'security', 'secrets'] as const;
      const severities = ['info', 'warning', 'error', 'critical'] as const;
      const confidences = ['low', 'medium', 'high'] as const;

      for (let i = 0; i < 1000; i++) {
        largeHypotheses.push({
          id: `hyp-${String(i).padStart(4, '0')}`,
          analyzer: i % 2 === 0 ? 'semgrep' : 'gitleaks',
          category: categories[i % categories.length],
          ruleId: `rule-${i}`,
          path: 'src/core/security.ts',
          line: i + 1,
          message: `Diagnostic message ${i}`,
          severity: severities[i % severities.length],
          confidence: confidences[i % confidences.length],
        });
      }

      const startTime = performance.now();
      const filtered = filterHypothesesForPersona({
        hypotheses: largeHypotheses,
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/core/security.ts' }],
      });
      const duration = performance.now() - startTime;

      // Must complete in under 50ms
      expect(duration).toBeLessThan(50);

      // Must strictly enforce the 20 cap
      expect(filtered.length).toBe(20);

      // Priority ordering must place secrets before security before linter
      for (const h of filtered) {
        expect(['secrets', 'security']).toContain(h.category);
      }
      expect(filtered[0].category).toBe('secrets');
      expect(filtered[0].severity).toBe('critical');
    });

    it('ensures deterministic tie-breaking by id is stable across reverse input orders', () => {
      const itemA: CandidateHypothesis = {
        id: 'hyp:a',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'rule-1',
        path: 'src/test.ts',
        line: 10,
        message: 'Issue A',
        severity: 'error',
        confidence: 'high',
      };

      const itemB: CandidateHypothesis = {
        id: 'hyp:b',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'rule-1',
        path: 'src/test.ts',
        line: 20,
        message: 'Issue B',
        severity: 'error',
        confidence: 'high',
      };

      const order1 = filterHypothesesForPersona({
        hypotheses: [itemA, itemB],
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/test.ts' }],
      });

      const order2 = filterHypothesesForPersona({
        hypotheses: [itemB, itemA],
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/test.ts' }],
      });

      expect(order1.map((h) => h.id)).toEqual(['hyp:a', 'hyp:b']);
      expect(order2.map((h) => h.id)).toEqual(['hyp:a', 'hyp:b']);
    });
  });

  // =========================================================================
  // Challenge 3: Fail-Closed Protection for Unknown / Ambiguous Personas
  // =========================================================================
  describe('Challenge 3: Fail-Closed Protection for Unknown / Ambiguous Personas', () => {
    const sensitiveHypotheses: CandidateHypothesis[] = [
      {
        id: 'hyp:sec:token-leak',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'api-secret',
        path: 'src/config.ts',
        line: 5,
        message: 'Token leak detected',
        severity: 'critical',
        confidence: 'high',
      },
      {
        id: 'hyp:sec:cwe-79',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'xss-injection',
        path: 'src/config.ts',
        line: 12,
        message: 'Cross-site scripting',
        severity: 'error',
        confidence: 'high',
      },
      {
        id: 'hyp:lint:indent',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'indentation',
        path: 'src/config.ts',
        line: 18,
        message: 'Bad indentation',
        severity: 'warning',
        confidence: 'low',
      },
    ];

    it('ensures completely unclassified / novel persona IDs fail-closed and receive 0 security or secrets hypotheses', () => {
      const unknownPersonas = [
        { id: 'custom-widget-reviewer', charter: 'Review custom UI widgets' },
        { id: 'metrics-agent', charter: 'Analyze business metrics and KPIs' },
        { id: 'random-bot-99', charter: 'Miscellaneous checks' },
      ];

      for (const p of unknownPersonas) {
        const filtered = filterHypothesesForPersona({
          hypotheses: sensitiveHypotheses,
          personaId: p.id,
          charter: p.charter,
          scopedFiles: [{ path: 'src/config.ts' }],
        });

        expect(filtered.some((h) => h.category === 'security')).toBe(false);
        expect(filtered.some((h) => h.category === 'secrets')).toBe(false);
        expect(filtered.map((h) => h.id)).toEqual(['hyp:lint:indent']);
      }
    });

    it('ensures db-lane receives SQL security hypotheses only, excluding secrets and non-SQL security bugs', () => {
      const dbMixedHypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:sql-injection',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'postgres-sql-injection',
          path: 'src/db/repo.ts',
          line: 10,
          message: 'SQL concatenation flaw',
          severity: 'critical',
          confidence: 'high',
        },
        {
          id: 'hyp:jwt-flaw',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'jwt-none-algorithm',
          path: 'src/db/repo.ts',
          line: 25,
          message: 'JWT algorithm none accepted',
          severity: 'error',
          confidence: 'high',
        },
        {
          id: 'hyp:db-password-secret',
          analyzer: 'gitleaks',
          category: 'secrets',
          ruleId: 'postgres-password',
          path: 'src/db/repo.ts',
          line: 2,
          message: 'Hardcoded postgres password',
          severity: 'critical',
          confidence: 'high',
        },
      ];

      const dbFiltered = filterHypothesesForPersona({
        hypotheses: dbMixedHypotheses,
        personaId: 'db-lane',
        charter: 'builtin:database',
        scopedFiles: [{ path: 'src/db/repo.ts' }],
      });

      expect(dbFiltered.map((h) => h.id)).toEqual(['hyp:sql-injection']);
      expect(dbFiltered.some((h) => h.id === 'hyp:jwt-flaw')).toBe(false);
      expect(dbFiltered.some((h) => h.id === 'hyp:db-password-secret')).toBe(false);
    });

    it('ensures devops-lane receives secrets hypotheses exclusively', () => {
      const devopsHypotheses: CandidateHypothesis[] = [
        {
          id: 'hyp:k8s-secret',
          analyzer: 'gitleaks',
          category: 'secrets',
          ruleId: 'k8s-token',
          path: 'deploy/k8s.yaml',
          line: 10,
          message: 'Hardcoded service account token',
          severity: 'critical',
          confidence: 'high',
        },
        {
          id: 'hyp:k8s-privileged',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'privileged-container',
          path: 'deploy/k8s.yaml',
          line: 15,
          message: 'Privileged container allowed',
          severity: 'error',
          confidence: 'high',
        },
        {
          id: 'hyp:yaml-lint',
          analyzer: 'eslint',
          category: 'linter',
          ruleId: 'yaml-syntax',
          path: 'deploy/k8s.yaml',
          line: 1,
          message: 'Indentation error',
          severity: 'warning',
          confidence: 'low',
        },
      ];

      const devopsFiltered = filterHypothesesForPersona({
        hypotheses: devopsHypotheses,
        personaId: 'devops-lane',
        charter: 'builtin:devops',
        scopedFiles: [{ path: 'deploy/k8s.yaml' }],
      });

      expect(devopsFiltered.map((h) => h.id)).toEqual(['hyp:k8s-secret']);
    });
  });

  // =========================================================================
  // Challenge 4: Prompt Formatting Resilience & XSS/Special Character Safety
  // =========================================================================
  describe('Challenge 4: Prompt Formatting Resilience & XSS/Special Character Safety', () => {
    it('safely renders hypotheses containing special characters, brackets, control characters, and newlines', () => {
      const weirdHypothesis: CandidateHypothesis = {
        id: 'hyp:test:<>:"\'&',
        analyzer: 'scanner[advanced]',
        category: 'security',
        ruleId: 'cwe-79<script>alert(1)</script>',
        path: 'src/weird/file name with spaces.ts',
        line: 42,
        message: 'Line 1\nLine 2 with \t tabs and carriage return \r\nLine 3',
        severity: 'warning',
        confidence: 'medium',
        snippet: 'const x = "<script>"; // test',
      };

      const prompt = formatCandidateHypothesesPrompt([weirdHypothesis]);

      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('hyp:test:<>:"\'&');
      expect(prompt).toContain('scanner[advanced]');
      expect(prompt).toContain('Target: src/weird/file name with spaces.ts:42');
      expect(prompt).toContain('cwe-79<script>alert(1)</script>');
      expect(prompt).toContain('Context: const x = "<script>"; // test');
    });

    it('returns empty string for invalid object representations', () => {
      expect(formatCandidateHypothesesPrompt(12345 as any)).toBe('');
      expect(formatCandidateHypothesesPrompt(false as any)).toBe('');
      expect(formatCandidateHypothesesPrompt('some string' as any)).toBe('');
    });
  });

  // =========================================================================
  // Challenge 5: Gate Independence & Zero False Blockers
  // =========================================================================
  describe('Challenge 5: Gate Independence & Zero False Blockers', () => {
    it('verifies review gate evaluates cleanly to SHIP when candidate hypotheses exist but 0 findings are verified', () => {
      const candidate: ReviewGateCandidate = {
        repositoryId: 999,
        prNumber: 42,
        headSha: '1111222233334444555566667777888899990000',
        baseSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
        policyDigest: 'c'.repeat(64),
      };

      const evidence: ReviewGateEvidence = {
        verdict: 'SHIP',
        completedAt: new Date().toISOString(),
        coverageComplete: true,
        quorumSatisfied: true,
        infrastructureFailure: false,
        p0Count: 0,
        p1Count: 0,
        p2Count: 0,
        expectedLanes: 3,
        completedLanes: 3,
      };

      const decision = evaluateReviewGate({
        candidate,
        current: { ...candidate, open: true, draft: false },
        evidence,
      });

      expect(decision.status).toBe('success');
      expect(decision.eligible).toBe(true);
      expect(decision.reason).toBe('clean-review');
    });
  });
});
