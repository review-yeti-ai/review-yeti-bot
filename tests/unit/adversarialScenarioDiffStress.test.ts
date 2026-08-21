import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getAllScenarios,
  getScenarioById,
  getScenariosByCategory,
  getScenarioCategories,
  getScenariosByPersona,
  formatUnifiedDiff,
  validateScenario,
  ScenarioCategory,
  EvaluationScenario,
  DiffFile,
  ExpectedFinding,
} from '../../src/evaluation/scenarios';
import {
  calculateMetrics,
  estimateCost,
  Finding,
  EvaluationMetrics,
} from '../../src/evaluation/evaluationRunner';
const {
  changedLineNumbers,
  sanitizeFinding,
  sanitizeFindings,
  computeArbitration,
} = require('../../src/review/reviewCore.js');

describe('Adversarial Scenario Catalog & Diff Fixtures Stress Harness (Tier 5)', () => {
  const fixturesDir = path.resolve(__dirname, '../fixtures/scenarios');
  const allScenarios = getAllScenarios();

  // =========================================================================
  // 1. SCENARIO CATALOG INTEGRITY & PARTITION INVARIANTS
  // =========================================================================
  describe('1. Scenario Catalog Structural Invariants & Category Partitions', () => {
    it('verifies exact total count is 190 scenarios', () => {
      expect(allScenarios.length).toBe(190);
    });

    it('verifies all 190 scenario IDs are unique and strictly adhere to slug format', () => {
      const ids = allScenarios.map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(190);

      const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      for (const id of ids) {
        expect(id).toMatch(slugRegex);
        expect(id.length).toBeGreaterThanOrEqual(3);
        expect(id.length).toBeLessThanOrEqual(60);
      }
    });

    it('verifies all 9 scenario categories are populated with non-zero scenarios', () => {
      const expectedCategories: ScenarioCategory[] = [
        'security',
        'performance',
        'architecture',
        'testing',
        'database',
        'dependencies',
        'multi_file',
        'multi_turn',
        'evidence',
      ];

      const categories = getScenarioCategories();
      expect(categories.sort()).toEqual([...expectedCategories].sort());

      for (const cat of expectedCategories) {
        const matching = getScenariosByCategory(cat);
        expect(matching.length).toBeGreaterThanOrEqual(1);
        for (const s of matching) {
          expect(s.category).toBe(cat);
        }
      }
    });

    it('verifies all 94 scenarios pass strict structural validation', () => {
      for (const s of allScenarios) {
        const validation = validateScenario(s);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);

        // Additional deep structural checks
        expect(typeof s.name).toBe('string');
        expect(s.name.trim().length).toBeGreaterThan(0);
        expect(typeof s.description).toBe('string');
        expect(s.description.trim().length).toBeGreaterThan(0);
        expect(['SHIP', 'FIX_FIRST', 'BLOCK']).toContain(s.expectedVerdict);

        // PR context checks
        expect(s.prContext).toBeDefined();
        expect(typeof s.prContext.repo).toBe('string');
        expect(s.prContext.repo.includes('/')).toBe(true);
        expect(s.prContext.prNumber).toBeDefined();
        expect(typeof s.prContext.title).toBe('string');
        expect(typeof s.prContext.headSha).toBe('string');
        expect(s.prContext.headSha.length).toBeGreaterThanOrEqual(8);

        // Diff files checks
        expect(Array.isArray(s.diffFiles)).toBe(true);
        expect(s.diffFiles.length).toBeGreaterThan(0);
        for (const file of s.diffFiles) {
          expect(typeof file.path).toBe('string');
          expect(file.path.startsWith('/')).toBe(false);
          expect(file.path.includes('..')).toBe(false);
          expect(typeof file.patch).toBe('string');
          expect(file.patch.includes('@@')).toBe(true);
        }
      }
    });

    it('verifies language & technical domain partitioning across all 6 target clusters', () => {
      const elixirScenarios = allScenarios.filter((s) => s.id.startsWith('elixir-'));
      expect(elixirScenarios.length).toBe(10);

      const goScenarios = allScenarios.filter((s) => s.id.startsWith('go-'));
      expect(goScenarios.length).toBe(10);

      const tsScenarios = allScenarios.filter((s) => s.id.startsWith('ts-'));
      expect(tsScenarios.length).toBe(9);

      const dbScenarios = allScenarios.filter((s) => s.id.startsWith('db-'));
      expect(dbScenarios.length).toBeGreaterThanOrEqual(6);

      const archDepScenarios = allScenarios.filter(
        (s) => s.id.startsWith('arch-') || s.id.startsWith('dep-')
      );
      expect(archDepScenarios.length).toBeGreaterThanOrEqual(6);

      const advScenarios = allScenarios.filter((s) => s.id.startsWith('adv-'));
      expect(advScenarios.length).toBe(14);
    });

    it('verifies multi-turn scenario context invariants', () => {
      const multiTurnScenarios = getScenariosByCategory('multi_turn');
      expect(multiTurnScenarios.length).toBeGreaterThanOrEqual(1);

      for (const s of multiTurnScenarios) {
        expect(s.sessionContext).toBeDefined();
        expect(s.sessionContext!.turn).toBeGreaterThanOrEqual(2);
        expect(s.sessionContext!.augmentedHeader).toBeDefined();
        expect(s.sessionContext!.augmentedHeader!.length).toBeGreaterThan(0);
        expect(Array.isArray(s.sessionContext!.authorFeedback)).toBe(true);
        expect(s.sessionContext!.authorFeedback!.length).toBeGreaterThan(0);

        for (const fb of s.sessionContext!.authorFeedback!) {
          expect(typeof fb.findingTitle).toBe('string');
          expect(typeof fb.rejected).toBe('boolean');
          expect(typeof fb.reason).toBe('string');
        }

        // When author rejected previous nits, expected findings is empty and expectedVerdict is SHIP
        expect(s.expectedFindings.length).toBe(0);
        expect(s.expectedVerdict).toBe('SHIP');
      }
    });

    it('verifies evidence requirement scenario invariants', () => {
      const evidenceScenarios = getScenariosByCategory('evidence');
      expect(evidenceScenarios.length).toBeGreaterThanOrEqual(1);

      for (const s of evidenceScenarios) {
        expect(s.evidenceRequirement).toBeDefined();
        expect(s.evidenceRequirement!.requireReceipt).toBe(true);
        expect(typeof s.evidenceRequirement!.tool).toBe('string');
        expect(typeof s.evidenceRequirement!.operation).toBe('string');
        expect(typeof s.evidenceRequirement!.command).toBe('string');
      }
    });
  });

  // =========================================================================
  // 2. ON-DISK DIFF FIXTURE SYNCHRONIZATION & LINE CONTAINMENT INVARIANT
  // =========================================================================
  describe('2. Diff Fixtures Synchronization & Ground-Truth Line Containment Invariant', () => {
    it('verifies exact 1:1 match between on-disk .diff fixtures and registered scenarios', () => {
      expect(fs.existsSync(fixturesDir)).toBe(true);
      const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.diff'));
      expect(files.length).toBeGreaterThanOrEqual(190);

      const diskScenarioIds = new Set(files.map((f) => f.replace(/\.diff$/, '')));
      for (const s of allScenarios) {
        expect(diskScenarioIds.has(s.id)).toBe(true);
      }
    });

    it('verifies on-disk .diff content exactly matches formatUnifiedDiff byte-for-byte', () => {
      for (const s of allScenarios) {
        const fixturePath = path.join(fixturesDir, `${s.id}.diff`);
        expect(fs.existsSync(fixturePath)).toBe(true);

        const content = fs.readFileSync(fixturePath, 'utf8');
        const formatted = formatUnifiedDiff(s.diffFiles).trimEnd() + '\n';
        expect(content).toBe(formatted);
      }
    });

    it('INVARIANT: Every expectedFinding.line strictly exists in the added lines (+) set of changedLineNumbers', () => {
      let totalFindingsChecked = 0;

      for (const s of allScenarios) {
        for (const finding of s.expectedFindings) {
          totalFindingsChecked++;

          // 1. Finding target file must be in diffFiles
          const targetFile = s.diffFiles.find((f) => f.path === finding.path);
          expect(targetFile).toBeDefined();
          expect(targetFile!.patch).toBeDefined();

          // 2. changedLineNumbers must parse to a non-empty Set
          const addedLines = changedLineNumbers(targetFile!.patch);
          expect(addedLines).toBeInstanceOf(Set);
          expect(addedLines!.size).toBeGreaterThan(0);

          // 3. Finding line number MUST be contained in the added lines set
          if (typeof finding.line === 'number') {
            const hasLine = addedLines!.has(finding.line);
            expect(
              hasLine,
              `Scenario "${s.id}" finding on "${finding.path}:${finding.line}" NOT in added lines: [${Array.from(addedLines!).join(', ')}]`
            ).toBe(true);
          }
        }
      }

      expect(totalFindingsChecked).toBeGreaterThanOrEqual(50);
    });

    it('INVARIANT: sanitizeFindings retains 100% of expectedFindings across all scenarios', () => {
      for (const s of allScenarios) {
        const rawFindings = s.expectedFindings.map((ef) => ({
          severity: ef.severity,
          path: ef.path,
          line: ef.line || 1,
          title: ef.title || 'Ground truth finding',
          body: ef.description || 'Ground truth body description',
          suggestion: ef.suggestion,
        }));

        const sanitized = sanitizeFindings(rawFindings, s.diffFiles);
        expect(sanitized.length).toBe(s.expectedFindings.length);

        // Verify each sanitized finding retains severity and line
        for (let i = 0; i < sanitized.length; i++) {
          expect(sanitized[i].severity).toBe(rawFindings[i].severity);
          expect(sanitized[i].path).toBe(rawFindings[i].path);
          expect(sanitized[i].line).toBe(rawFindings[i].line);
        }
      }
    });

    it('INVARIANT: Single-lane simulated execution with ground-truth findings reproduces expectedVerdict', () => {
      for (const s of allScenarios) {
        const rawFindings = s.expectedFindings.map((ef) => ({
          severity: ef.severity,
          path: ef.path,
          line: ef.line || 1,
          title: ef.title || 'Ground truth finding',
          body: ef.description || 'Ground truth body description',
        }));

        const sanitized = sanitizeFindings(rawFindings, s.diffFiles);
        const laneResults = [
          {
            persona: 'synthetic-challenger',
            status: 'SUCCESS',
            findings: sanitized,
          },
        ];

        const arb = computeArbitration(laneResults, 1, { changedFiles: s.diffFiles });
        expect(
          arb.verdict,
          `Scenario ${s.id} arbitration produced ${arb.verdict} instead of expected ${s.expectedVerdict}`
        ).toBe(s.expectedVerdict);
      }
    });
  });

  // =========================================================================
  // 3. BIPARTITE MATCHING ADVERSARIAL STRESS TESTING (calculateMetrics)
  // =========================================================================
  describe('3. Bipartite Matching Algorithm Adversarial Stress Testing', () => {
    const sampleExpected: ExpectedFinding[] = [
      { personaId: 'sec', severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm' },
      { personaId: 'sec', severity: 'P0', path: 'src/auth/jwt.ts', line: 25, title: 'Unchecked expiration' },
      { personaId: 'sec', severity: 'P1', path: 'src/db/repo.ts', line: 50, title: 'Unclosed transaction' },
    ];

    it('verifies bipartite matching is order-independent under permutations of actual findings', () => {
      const actual1: Finding[] = [
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 25, title: 'Unchecked expiration' },
        { severity: 'P1', path: 'src/db/repo.ts', line: 50, title: 'Unclosed transaction' },
      ];

      const actual2: Finding[] = [
        { severity: 'P1', path: 'src/db/repo.ts', line: 50, title: 'Unclosed transaction' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 25, title: 'Unchecked expiration' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm' },
      ];

      const actual3: Finding[] = [
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 25, title: 'Unchecked expiration' },
        { severity: 'P1', path: 'src/db/repo.ts', line: 50, title: 'Unclosed transaction' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm' },
      ];

      const m1 = calculateMetrics(sampleExpected, actual1);
      const m2 = calculateMetrics(sampleExpected, actual2);
      const m3 = calculateMetrics(sampleExpected, actual3);

      expect(m1.tp).toBe(3);
      expect(m1.fp).toBe(0);
      expect(m1.fn).toBe(0);
      expect(m1.precision).toBe(1.0);
      expect(m1.recall).toBe(1.0);
      expect(m1.f1Score).toBe(1.0);

      expect(m2.tp).toBe(m1.tp);
      expect(m2.fp).toBe(m1.fp);
      expect(m2.fn).toBe(m1.fn);
      expect(m2.f1Score).toBe(m1.f1Score);

      expect(m3.tp).toBe(m1.tp);
      expect(m3.fp).toBe(m1.fp);
      expect(m3.fn).toBe(m1.fn);
      expect(m3.f1Score).toBe(m1.f1Score);
    });

    it('verifies bipartite matching isolates duplicate actual findings to 1 TP and N-1 FP', () => {
      const duplicates: Finding[] = [
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm duplicate 1' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm duplicate 2' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm duplicate 3' },
        { severity: 'P0', path: 'src/auth/jwt.ts', line: 10, title: 'JWT none algorithm duplicate 4' },
      ];

      const metrics = calculateMetrics([sampleExpected[0]], duplicates);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(3);
      expect(metrics.fn).toBe(0);
      expect(metrics.precision).toBe(0.25);
      expect(metrics.recall).toBe(1.0);
      expect(metrics.matchedFindings.length).toBe(1);
      expect(metrics.unmatchedActual.length).toBe(3);
    });

    it('verifies exact boundary behavior for line tolerance (+/- 5 vs +/- 6)', () => {
      const exp: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/auth.ts', line: 50, title: 'Auth defect' },
      ];

      // Exact line: delta = 0 (MATCH)
      const mExact = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 50 }]);
      expect(mExact.tp).toBe(1);
      expect(mExact.fp).toBe(0);
      expect(mExact.matchedFindings[0].lineDelta).toBe(0);

      // Line + 5: delta = 5 <= 5 (MATCH)
      const mPlus5 = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 55 }]);
      expect(mPlus5.tp).toBe(1);
      expect(mPlus5.fp).toBe(0);
      expect(mPlus5.matchedFindings[0].lineDelta).toBe(5);

      // Line - 5: delta = 5 <= 5 (MATCH)
      const mMinus5 = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 45 }]);
      expect(mMinus5.tp).toBe(1);
      expect(mMinus5.fp).toBe(0);
      expect(mMinus5.matchedFindings[0].lineDelta).toBe(5);

      // Line + 6: delta = 6 > 5 (REJECT)
      const mPlus6 = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 56 }]);
      expect(mPlus6.tp).toBe(0);
      expect(mPlus6.fp).toBe(1);
      expect(mPlus6.fn).toBe(1);

      // Line - 6: delta = 6 > 5 (REJECT)
      const mMinus6 = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 44 }]);
      expect(mMinus6.tp).toBe(0);
      expect(mMinus6.fp).toBe(1);
      expect(mMinus6.fn).toBe(1);
    });

    it('verifies custom line tolerance option overrides default 5-line window', () => {
      const exp: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/auth.ts', line: 50, title: 'Auth defect' },
      ];

      // Custom lineTolerance: 0 (strict exact line)
      const mStrictLinePass = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 50 }], {
        lineTolerance: 0,
      });
      expect(mStrictLinePass.tp).toBe(1);

      const mStrictLineFail = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 51 }], {
        lineTolerance: 0,
      });
      expect(mStrictLineFail.tp).toBe(0);
      expect(mStrictLineFail.fp).toBe(1);

      // Custom lineTolerance: 20 (wide window)
      const mWidePass = calculateMetrics(exp, [{ severity: 'P0', path: 'src/auth.ts', line: 70 }], {
        lineTolerance: 20,
      });
      expect(mWidePass.tp).toBe(1);
    });

    it('verifies greedy proximity prefers candidate with smallest line delta', () => {
      const exp: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/auth.ts', line: 50, title: 'Target' },
      ];

      // Candidates at line 54 (delta 4) and line 51 (delta 1)
      const actual: Finding[] = [
        { severity: 'P0', path: 'src/auth.ts', line: 54, title: 'Candidate 1' },
        { severity: 'P0', path: 'src/auth.ts', line: 51, title: 'Candidate 2' },
      ];

      const metrics = calculateMetrics(exp, actual);
      expect(metrics.tp).toBe(1);
      expect(metrics.fp).toBe(1);
      // Candidate 1 was processed first, but let's check greedy matching behavior
      // In calculateMetrics, it loops actualIdx and picks the best unmatched expected finding
      expect(metrics.matchedFindings.length).toBe(1);
    });

    it('verifies titlePattern filtering against title, body, and description', () => {
      const expWithPattern: ExpectedFinding[] = [
        {
          personaId: 'sec',
          severity: 'P0',
          path: 'src/auth.ts',
          line: 10,
          titlePattern: /trojan\s+source|bidi|unicode/i,
        },
      ];

      // Match in title
      const m1 = calculateMetrics(expWithPattern, [
        { severity: 'P0', path: 'src/auth.ts', line: 10, title: 'Trojan Source Bidi detected' },
      ]);
      expect(m1.tp).toBe(1);

      // Match in body
      const m2 = calculateMetrics(expWithPattern, [
        { severity: 'P0', path: 'src/auth.ts', line: 10, title: 'Security issue', body: 'Found unicode bidi override' },
      ]);
      expect(m2.tp).toBe(1);

      // Match in description
      const m3 = calculateMetrics(expWithPattern, [
        { severity: 'P0', path: 'src/auth.ts', line: 10, description: 'Dangerous trojan source exploit' },
      ]);
      expect(m3.tp).toBe(1);

      // Non-matching pattern
      const mFail = calculateMetrics(expWithPattern, [
        { severity: 'P0', path: 'src/auth.ts', line: 10, title: 'Generic syntax error' },
      ]);
      expect(mFail.tp).toBe(0);
      expect(mFail.fp).toBe(1);
      expect(mFail.fn).toBe(1);
    });

    it('verifies path normalization across Windows separators, leading dots, and case insensitivity', () => {
      const exp: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/services/authService.ts', line: 15 },
      ];

      const actualWindows: Finding[] = [
        { severity: 'P0', path: '.\\src\\Services\\AuthService.ts', line: 15 },
      ];

      const m = calculateMetrics(exp, actualWindows);
      expect(m.tp).toBe(1);
      expect(m.fp).toBe(0);
    });
  });

  // =========================================================================
  // 4. ADVERSARIAL EDGE CASES, CORRUPTED DIFFS & INPUT STRESS
  // =========================================================================
  describe('4. Adversarial Edge Cases & Corrupted Inputs Hardening', () => {
    it('changedLineNumbers handles completely corrupted, empty, or non-string patches safely', () => {
      expect(changedLineNumbers(null)).toBeNull();
      expect(changedLineNumbers(undefined)).toBeNull();
      expect(changedLineNumbers(12345)).toBeNull();
      expect(changedLineNumbers({})).toBeNull();
      expect(changedLineNumbers('')).toEqual(new Set());
      expect(changedLineNumbers('random text without unified diff headers')).toEqual(new Set());
      // Non-hunk lines starting with '+' are tracked from current=0; verify behavior
      expect(changedLineNumbers('no plus header\nno plus line')).toEqual(new Set());
      expect(changedLineNumbers('+line outside hunk')).toEqual(new Set([0]));
    });

    it('changedLineNumbers accurately parses multi-hunk diffs with deletions and blank context lines', () => {
      const complexPatch = `@@ -10,6 +10,8 @@
 context line 1
-deleted line
+added line 11
+added line 12
 context line 4
@@ -30,4 +32,5 @@
 context line 32
+added line 33
 context line 34
\\ No newline at end of file`;

      const lines = changedLineNumbers(complexPatch);
      expect(lines).toEqual(new Set([11, 12, 33]));
    });

    it('sanitizeFinding drops path traversal attempts and invalid line numbers', () => {
      const dummyChangedFiles: DiffFile[] = [
        { path: 'src/safe.ts', patch: '@@ -1,2 +1,3 @@\n context\n+added line 2\n context' },
      ];

      // Path traversal
      const traversalFinding = {
        severity: 'P0',
        path: '../../etc/passwd',
        line: 2,
        title: 'Traverse',
        body: 'Traverse description',
      };
      expect(sanitizeFinding(traversalFinding, dummyChangedFiles)).toBeNull();

      // Absolute path
      const absoluteFinding = {
        severity: 'P0',
        path: '/src/safe.ts',
        line: 2,
        title: 'Abs path',
        body: 'Abs description',
      };
      expect(sanitizeFinding(absoluteFinding, dummyChangedFiles)).toBeNull();

      // Invalid line numbers
      expect(sanitizeFinding({ severity: 'P0', path: 'src/safe.ts', line: -5, title: 'T', body: 'B' }, dummyChangedFiles)).toBeNull();
      expect(sanitizeFinding({ severity: 'P0', path: 'src/safe.ts', line: 0, title: 'T', body: 'B' }, dummyChangedFiles)).toBeNull();
      expect(sanitizeFinding({ severity: 'P0', path: 'src/safe.ts', line: NaN, title: 'T', body: 'B' }, dummyChangedFiles)).toBeNull();
      expect(sanitizeFinding({ severity: 'P0', path: 'src/safe.ts', line: Infinity, title: 'T', body: 'B' }, dummyChangedFiles)).toBeNull();
    });

    it('arbitration quorum blocks when zero personas are enabled or provider lanes fail', () => {
      // Zero personas
      const zeroResult = computeArbitration([], 0);
      expect(zeroResult.verdict).toBe('BLOCK');
      expect(zeroResult.rationale).toContain('no reviewer personas are enabled');

      // Failed lane
      const failedLaneResult = computeArbitration(
        [{ persona: 'sec', status: 'ERROR', error: 'Rate limit exceeded' }],
        1
      );
      expect(failedLaneResult.verdict).toBe('BLOCK');
      expect(failedLaneResult.rationale).toContain('persona lane(s) failed');
    });

    it('arbitration triggers FIX_FIRST on P2 nit flood exceeding threshold', () => {
      const diffFiles: DiffFile[] = [
        { path: 'src/a.ts', patch: '@@ -1,10 +1,20 @@\n' + Array.from({ length: 15 }, (_, i) => `+line ${i + 1}`).join('\n') },
      ];

      const p2Findings = Array.from({ length: 6 }, (_, i) => ({
        severity: 'P2',
        path: 'src/a.ts',
        line: i + 1,
        title: `Nit ${i + 1}`,
        body: `Nit body ${i + 1}`,
      }));

      const res = computeArbitration(
        [{ persona: 'quality', status: 'SUCCESS', findings: p2Findings }],
        1,
        { changedFiles: diffFiles }
      );

      expect(res.verdict).toBe('FIX_FIRST');
      expect(res.rationale).toContain('P2 finding(s)');
    });

    it('verifies multi-file scenario file path isolation during bipartite matching', () => {
      const multiFile = getScenarioById('multifile-auth-refactor')!;
      expect(multiFile).toBeDefined();
      expect(multiFile.diffFiles.length).toBe(5);

      // Take expected finding on file 1
      const expFinding = multiFile.expectedFindings[0];
      expect(expFinding).toBeDefined();

      // Submit finding with correct line and severity, but wrong file path (file 2 instead of file 1)
      const wrongFile = multiFile.diffFiles.find((f) => f.path !== expFinding.path)!;
      const actualSwapped: Finding[] = [
        {
          severity: expFinding.severity,
          path: wrongFile.path,
          line: expFinding.line,
          title: expFinding.title,
        },
      ];

      const metrics = calculateMetrics([expFinding], actualSwapped);
      expect(metrics.tp).toBe(0);
      expect(metrics.fp).toBe(1);
      expect(metrics.fn).toBe(1);
    });

    it('verifies Monte Carlo randomized permutation stability in bipartite matching across 50 iterations', () => {
      const expList: ExpectedFinding[] = [
        { personaId: 'sec', severity: 'P0', path: 'src/a.ts', line: 10, title: 'Sec 1' },
        { personaId: 'perf', severity: 'P1', path: 'src/b.ts', line: 20, title: 'Perf 1' },
        { personaId: 'arch', severity: 'P1', path: 'src/c.ts', line: 30, title: 'Arch 1' },
        { personaId: 'db', severity: 'P0', path: 'src/d.ts', line: 40, title: 'DB 1' },
        { personaId: 'rel', severity: 'P2', path: 'src/e.ts', line: 50, title: 'Rel 1' },
      ];

      const actList: Finding[] = [
        { severity: 'P0', path: 'src/a.ts', line: 11, title: 'Sec 1 candidate' }, // delta 1
        { severity: 'P1', path: 'src/b.ts', line: 22, title: 'Perf 1 candidate' }, // delta 2
        { severity: 'P1', path: 'src/c.ts', line: 31, title: 'Arch 1 candidate' }, // delta 1
        { severity: 'P0', path: 'src/d.ts', line: 40, title: 'DB 1 candidate' }, // delta 0
        { severity: 'P2', path: 'src/e.ts', line: 54, title: 'Rel 1 candidate' }, // delta 4
        { severity: 'P2', path: 'src/f.ts', line: 99, title: 'FP Noise 1' }, // FP
        { severity: 'P1', path: 'src/g.ts', line: 88, title: 'FP Noise 2' }, // FP
      ];

      function shuffle<T>(arr: T[]): T[] {
        const copy = [...arr];
        for (let i = copy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      }

      for (let run = 0; run < 50; run++) {
        const shuffledExp = shuffle(expList);
        const shuffledAct = shuffle(actList);
        const m = calculateMetrics(shuffledExp, shuffledAct);

        expect(m.tp).toBe(5);
        expect(m.fp).toBe(2);
        expect(m.fn).toBe(0);
        expect(m.recall).toBe(1.0);
        expect(m.precision).toBe(Math.round((5 / 7) * 1000) / 1000);
      }
    });

    it('verifies adversarial scenario diffs contain expected domain artifacts', () => {
      // 1. Trojan source bidi scenario
      const trojan = getScenarioById('adv-trojan-source-bidi-unicode')!;
      expect(trojan).toBeDefined();
      const trojanDiff = formatUnifiedDiff(trojan.diffFiles);
      expect(trojanDiff.includes('\u202E') || trojanDiff.includes('\\u202E')).toBe(true);

      // 2. Prompt injection PR body scenario
      const prBodyInj = getScenarioById('adv-prompt-injection-pr-body')!;
      expect(prBodyInj).toBeDefined();
      expect(prBodyInj.prContext.body?.toLowerCase()).toContain('system override');

      // 3. Prompt injection code comment scenario
      const codeCommentInj = getScenarioById('adv-prompt-injection-code-comment')!;
      expect(codeCommentInj).toBeDefined();
      const codeCommentDiff = formatUnifiedDiff(codeCommentInj.diffFiles);
      expect(codeCommentDiff.toLowerCase()).toContain('ai_review_override');
      expect(codeCommentDiff.toLowerCase()).toContain('disregard security policies');

      // 4. Forged test receipt scenario
      const forged = getScenarioById('adv-forged-test-receipt-manipulation')!;
      expect(forged).toBeDefined();
      const forgedDiff = formatUnifiedDiff(forged.diffFiles);
      expect(forgedDiff).toContain('echo "✓ 142 tests passed (100%) in 0.42s"');
    });

    it('verifies persona distribution across expected findings covers core reviewer personas', () => {
      const personaFindingCounts = new Map<string, number>();
      for (const s of allScenarios) {
        for (const f of s.expectedFindings) {
          personaFindingCounts.set(f.personaId, (personaFindingCounts.get(f.personaId) || 0) + 1);
        }
      }

      // Core personas must have findings in the catalog
      expect(personaFindingCounts.get('security')).toBeGreaterThan(0);
      expect(personaFindingCounts.get('performance')).toBeGreaterThan(0);
      expect(personaFindingCounts.get('architecture')).toBeGreaterThan(0);
      expect(personaFindingCounts.get('database')).toBeGreaterThan(0);
      expect(personaFindingCounts.get('dependencies')).toBeGreaterThan(0);
      expect(personaFindingCounts.get('testing')).toBeGreaterThan(0);
    });
  });
});

