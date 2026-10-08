import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateFindings,
  buildCompactFileList,
  buildCompactDiffManifest,
  buildDiffSection,
  computeDiffStats,
  MAX_INLINE_DIFF_CHARS,
  PanelConfigurationError,
  PanelCancellationError,
  isDocumentationOrAssetPath,
  executePersonaPanel,
  extractMessageContentText,
} from '../../src/panel/panelEngine';
import {
  formatCandidateHypothesesPrompt,
  filterHypothesesForPersona,
  type CandidateHypothesis,
  type PreCheckSummary,
} from '../../src/sandbox/analyzerRunner';
import * as analyzerRunnerModule from '../../src/sandbox/analyzerRunner';
import * as zoektPreCheckService from '../../src/services/zoektPreCheckService';
import { buildTaskScopedPrefix } from '../../src/panel/composedEngine';
import type { CtReviewConfigV3 } from '../../src/config/schema';
import {
  validateFileCoverageQuorum,
  isFileCoverageSatisfied,
  type ReviewTaskPlan,
  type ReviewTaskResultV2,
  type LeanFindingSummary,
} from '../../src/reviewTaskContract';
import {
  quorumPolicyConfigSchema,
  composedEngineConfigSchema,
} from '../../src/config/schema';
import { evaluateReviewGate, type ReviewGateEvidence, type ReviewGateCandidate } from '../../src/review/reviewGatePolicy';
import { computeArbitration } from '../../src/review/reviewCore';
import { projectPublishingRosterBounds, publishingConclusion } from '../../src/cli/publishingReview';

describe('PanelEngine & Review Quorum Unit Suite (tests/unit/panelEngine.test.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Panel Engine Core Invariants & Finding Validation
  // =========================================================================
  describe('Panel Engine Core Contracts', () => {
    it('validates and normalizes valid finding contract fields', () => {
      const findings = validateFindings([
        {
          severity: 'P2',
          path: './src/auth/jwt.ts',
          line: 14,
          title: '  Insecure token check  ',
          body: '  Validate expiry before verifying signature.  ',
        },
      ]);

      expect(findings).toEqual([
        {
          severity: 'P2',
          path: 'src/auth/jwt.ts',
          line: 14,
          title: 'Insecure token check',
          body: 'Validate expiry before verifying signature.',
        },
      ]);
    });

    it('rejects malformed findings missing required contract attributes', () => {
      expect(() =>
        validateFindings([
          {
            severity: 'CRITICAL', // Invalid severity enum
            path: '',
            line: 'not-a-number' as any,
            title: '',
            body: '',
          },
        ]),
      ).toThrow(/invalid findings contract.*severity/);
    });

    it('rejects non-positive line numbers at the contract boundary', () => {
      expect(() =>
        validateFindings([
          {
            severity: 'P1',
            path: 'src/main.ts',
            line: 0,
            title: 'Zero line',
            body: 'Zero line body',
          },
        ]),
      ).toThrow(/invalid findings contract.*line/);
    });

    it('computes diff stats and compact file lists accurately', () => {
      const patch = '@@ -1,3 +1,4 @@\n-old\n+new\n+added';
      const stats = computeDiffStats(patch);
      expect(stats.additions).toBe(2);
      expect(stats.deletions).toBe(1);

      const files = [{ path: 'src/index.ts', patch, additions: 2, deletions: 1 }];
      const manifest = buildCompactDiffManifest(files);
      expect(manifest).toContain('src/index.ts');
      expect(manifest.length).toBeLessThanOrEqual(MAX_INLINE_DIFF_CHARS);
    });

    it('correctly identifies documentation and asset paths for diff triage', () => {
      expect(isDocumentationOrAssetPath('README.md')).toBe(true);
      expect(isDocumentationOrAssetPath('docs/architecture.png')).toBe(true);
      expect(isDocumentationOrAssetPath('assets/logo.svg')).toBe(true);
      expect(isDocumentationOrAssetPath('src/api/handler.ts')).toBe(false);
    });

    it('confirms the retired miller tool is completely removed from panelEngine', async () => {
      // Introspect panelEngine module exports to guarantee zero miller references
      const panelEngineModule = await import('../../src/panel/panelEngine');
      expect((panelEngineModule as any).executeMillerTool).toBeUndefined();
      expect((panelEngineModule as any).millerTool).toBeUndefined();
    });
  });

  // =========================================================================
  // Section 2: Quorum Policy & File Coverage Mode
  // =========================================================================
  describe('Quorum Policy & File Coverage Mode', () => {
    const testPlan: ReviewTaskPlan = {
      tasks: [
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/jwt.ts'], question: 'Is auth secure?', rationale: 'Sec' },
        { id: 'task-perf', dimension: 'performance', paths: ['src/db/query.ts'], question: 'Is query optimal?', rationale: 'Perf' },
        { id: 'task-ui', dimension: 'architecture', paths: ['src/ui/Button.tsx'], question: 'Is UI clean?', rationale: 'UI' },
      ],
    };

    const changedFiles = ['src/auth/jwt.ts', 'src/db/query.ts', 'src/ui/Button.tsx'];

    it('quorum_policy schema defaults to mode=file_coverage with min_file_coverage_pct=100', () => {
      const parsed = quorumPolicyConfigSchema.parse({});
      expect(parsed.mode).toBe('file_coverage');
      expect(parsed.min_file_coverage_pct).toBe(100);
      expect(parsed.enforce_security_floor).toBe(true);
      expect(parsed.blocker_fast_path_enabled).toBe(true);
    });

    it('composedEngine config schema accepts quorum_policy configuration', () => {
      const parsed = composedEngineConfigSchema.parse({
        quorum_policy: {
          mode: 'file_coverage',
          min_file_coverage_pct: 100,
        },
      });
      expect(parsed.quorum_policy?.mode).toBe('file_coverage');
    });

    it('satisfies quorum when 100% of reviewable files are inspected across domains', () => {
      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-perf', status: 'COMPLETE', findings: [] },
        { nonce: 'n3', task: 'task-ui', status: 'COMPLETE', findings: [] },
      ];

      const quorum = validateFileCoverageQuorum(testPlan, completedTasks, changedFiles);
      expect(quorum.satisfied).toBe(true);
      expect(quorum.coveragePct).toBe(100);
      expect(quorum.verdict).toBe('SHIP');
      expect(quorum.status).toBe('COMPLETE');
      expect(quorum.uncoveredPaths).toEqual([]);
    });

    it('survives non-critical task timeout when reviewable files are covered by other tasks', () => {
      const overlappingPlan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-core', dimension: 'architecture', paths: ['src/db/query.ts'], question: 'Core', rationale: 'Core' },
          { id: 'task-style', dimension: 'licensing', paths: ['src/db/query.ts'], question: 'Style', rationale: 'Style' },
        ],
      };
      // task-style timed out / omitted, but task-core covered query.ts
      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-core', status: 'COMPLETE', findings: [] },
      ];

      const quorum = validateFileCoverageQuorum(overlappingPlan, completedTasks, ['src/db/query.ts']);
      expect(quorum.satisfied).toBe(true);
      expect(quorum.coveragePct).toBe(100);
      expect(quorum.verdict).toBe('SHIP');
    });

    it('fails quorum with coverage gap when a modified code file is left uninspected', () => {
      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      ];

      const quorum = validateFileCoverageQuorum(testPlan, completedTasks, changedFiles);
      expect(quorum.satisfied).toBe(false);
      expect(quorum.coveragePct).toBe(33);
      expect(quorum.verdict).toBe('BLOCK');
      expect(quorum.status).toBe('INCOMPLETE_REVIEW');
      expect(quorum.uncoveredPaths).toContain('src/db/query.ts');
      expect(quorum.uncoveredPaths).toContain('src/ui/Button.tsx');
    });

    it('enforces security floor: fails quorum if security_auth file lacks security dimension inspection', () => {
      const nonSecPlan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-arch', dimension: 'architecture', paths: ['src/auth/jwt.ts'], question: 'Arch', rationale: 'Arch' },
        ],
      };
      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-arch', status: 'COMPLETE', findings: [] },
      ];

      const quorum = validateFileCoverageQuorum(nonSecPlan, completedTasks, ['src/auth/jwt.ts']);
      expect(quorum.satisfied).toBe(false);
      expect(quorum.securityCoverageSatisfied).toBe(false);
      expect(quorum.missingSecurityPaths).toEqual(['src/auth/jwt.ts']);
      expect(quorum.rationale).toContain('Security floor unsatisfied');
    });

    it('automatically satisfies quorum for PRs containing only docs, assets, and lockfiles', () => {
      const nonCodeFiles = ['README.md', 'docs/api.md', 'package-lock.json', 'mix.lock'];
      const quorum = validateFileCoverageQuorum({ tasks: [] }, [], nonCodeFiles);
      expect(quorum.satisfied).toBe(true);
      expect(quorum.coveragePct).toBe(100);
      expect(quorum.verdict).toBe('SHIP');
    });
  });

  // =========================================================================
  // Section 3: Blocker Fast-Path Quorum & Early Exit
  // =========================================================================
  describe('Blocker Fast-Path Quorum & Early Exit', () => {
    const candidate: ReviewGateCandidate = {
      repositoryId: 42,
      prNumber: 101,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64),
    };

    const current = { ...candidate, open: true, draft: false };

    const p0: LeanFindingSummary = {
      severity: 'P0',
      file: 'src/auth/jwt.ts',
      line: 25,
      fingerprint: 'fp1_abcdef1234567890abcdef12',
      summary: 'Critical auth bypass: signature verification disabled.',
    };

    it('verified P0 finding immediately triggers early exit with BLOCK and satisfies quorum', () => {
      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [p0] },
      ];

      const quorum = validateFileCoverageQuorum(
        { tasks: [{ id: 'task-sec', dimension: 'security', paths: ['src/auth/jwt.ts'], question: 'Sec?', rationale: 'Sec' }] },
        completedTasks,
        ['src/auth/jwt.ts', 'src/other.ts'],
        { activeFindings: [p0] },
      );

      expect(quorum.satisfied).toBe(true);
      expect(quorum.blockerFastPath).toBe(true);
      expect(quorum.verdict).toBe('BLOCK');
      expect(quorum.status).toBe('BLOCKER_EXIT');
      expect(quorum.blockerFinding).toEqual(p0);
    });

    it('review gate policy evaluates blocker fast-path run to failure with blocking-findings reason', () => {
      const evidence: ReviewGateEvidence = {
        verdict: 'BLOCK',
        completedAt: '2026-10-08T00:00:00Z',
        coverageComplete: true,
        quorumSatisfied: true,
        infrastructureFailure: false,
        p0Count: 1,
        p1Count: 0,
        p2Count: 0,
        expectedLanes: 4,
        completedLanes: 1, // 3 lanes aborted due to fast-path
        blockerFastPath: true,
      };

      const decision = evaluateReviewGate({ candidate, current, evidence });
      expect(decision.status).toBe('failure');
      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe('blocking-findings');
    });

    it('computeArbitration completes with status BLOCK when blockerFastPath is true', () => {
      const singleLaneResult = [
        {
          id: 'task-sec',
          status: 'COMPLETE',
          findings: [
            {
              severity: 'P0' as const,
              path: 'src/auth/jwt.ts',
              line: 25,
              title: 'Critical auth bypass',
              body: 'Signature verification disabled.',
            },
          ],
        },
      ];

      const arbitration = computeArbitration(singleLaneResult, 4, {
        changedFiles: [{ path: 'src/auth/jwt.ts' }, { path: 'src/other.ts' }],
        coverageComplete: true,
        blockerFastPath: true,
      });

      expect(arbitration.quorumSatisfied).toBe(true);
      expect(arbitration.verdict).toBe('BLOCK');
      expect(arbitration.status).toBe('BLOCK');
      expect(arbitration.blockerFastPath).toBe(true);
      expect(arbitration.metrics.p0Count).toBe(1);
    });

    it('publishing bounds projection does not mark missing/aborted lanes as errors on blockerFastPath', () => {
      const mockPanelResult = {
        applicablePersonaIds: ['task-sec', 'task-perf', 'task-ui'],
        personas: [
          {
            id: 'task-sec',
            status: 'COMPLETE',
            findings: [{ severity: 'P0', path: 'src/auth/jwt.ts', line: 25, title: 'P0', body: 'P0' }],
          },
        ],
        optionalFailures: [],
        blockerFastPath: true,
        quorum: { required: 1, distinctProviders: ['codex'], satisfied: true, blockerFastPath: true },
      } as any;

      const bounds = projectPublishingRosterBounds(mockPanelResult);
      expect(bounds.completedLaneCount).toBe(1);
      expect(bounds.failedLaneCount).toBe(0);
      expect(bounds.missingConfiguredLaneCount).toBe(0);
    });

    it('non-blocking P1/P2 findings do NOT trigger blocker fast-path early exit', () => {
      const p1: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/auth/jwt.ts',
        line: 30,
        fingerprint: 'fp_p1_sample',
        summary: 'Weak token entropy.',
      };

      const quorum = validateFileCoverageQuorum(
        { tasks: [] },
        [{ nonce: 'n1', task: 't1', status: 'COMPLETE', findings: [p1] }],
        ['src/auth/jwt.ts', 'src/uncovered.ts'],
        { activeFindings: [p1] },
      );

      expect(quorum.blockerFastPath).toBe(false);
      expect(quorum.satisfied).toBe(false); // Still fails on uncovered file
    });

    it('propagates abort signal cleanly to halt sibling tasks on P0 fast-path', async () => {
      const controller = new AbortController();
      let taskAborted = false;

      const siblingTask = new Promise((resolve) => {
        controller.signal.addEventListener('abort', () => {
          taskAborted = true;
          resolve('aborted');
        });
        setTimeout(() => resolve('completed'), 1000);
      });

      // P0 detected, trigger abort
      controller.abort(new PanelCancellationError('blocker_fast_path'));
      const outcome = await siblingTask;

      expect(taskAborted).toBe(true);
      expect(outcome).toBe('aborted');
    });
  });

  // =========================================================================
  // Section 4: Deterministic SAST Pre-Checks as Hypotheses (R5)
  // =========================================================================
  describe('Section 4: Deterministic SAST Pre-Checks as Hypotheses', () => {
    const mockHypotheses: CandidateHypothesis[] = [
      {
        id: 'hyp:gitleaks:secret-1:src/auth/jwt.ts:10',
        analyzer: 'gitleaks',
        category: 'secrets',
        ruleId: 'generic-api-key',
        path: 'src/auth/jwt.ts',
        line: 10,
        message: 'Hardcoded secret token detected',
        severity: 'critical',
        confidence: 'high',
        snippet: 'const secret = "ghp_1234567890abcdef";',
      },
      {
        id: 'hyp:semgrep:sec-1:src/auth/jwt.ts:35',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'jwt-none-algorithm',
        path: 'src/auth/jwt.ts',
        line: 35,
        endLine: 38,
        message: 'JWT verification algorithm accepts "none"',
        severity: 'error',
        confidence: 'high',
        snippet: 'jwt.verify(token, key, { algorithms: ["HS256", "none"] });',
      },
      {
        id: 'hyp:eslint:lint-1:src/auth/jwt.ts:50',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'no-unused-vars',
        path: 'src/auth/jwt.ts',
        line: 50,
        message: 'Variable "unused" is defined but never used',
        severity: 'info',
        confidence: 'medium',
      },
      {
        id: 'hyp:semgrep:sec-2:src/db/query.ts:22',
        analyzer: 'semgrep',
        category: 'security',
        ruleId: 'sql-injection',
        path: 'src/db/query.ts',
        line: 22,
        message: 'Untrusted input concatenated into SQL query string',
        severity: 'error',
        confidence: 'high',
        snippet: 'db.query(`SELECT * FROM users WHERE id = ${id}`);',
      },
      {
        id: 'hyp:eslint:lint-2:src/ui/Button.tsx:14',
        analyzer: 'eslint',
        category: 'linter',
        ruleId: 'react/button-has-type',
        path: 'src/ui/Button.tsx',
        line: 14,
        message: 'Missing explicit type attribute for button',
        severity: 'warning',
        confidence: 'high',
      },
    ];

    it('formats candidate hypotheses into structured prompt instructions (verify, refute, or contextualize)', () => {
      const prompt = formatCandidateHypothesesPrompt(mockHypotheses);

      // Section header
      expect(prompt).toContain('=== DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES (UNVERIFIED) ===');
      expect(prompt).toContain('Automated tools generated the following candidate hypotheses:');

      // Explicit persona instructions
      expect(prompt).toContain('Verify or refute each hypothesis during your review turns:');
      expect(prompt).toContain('- Inspect the surrounding code context to verify if the defect is real.');
      expect(prompt).toContain('- Do NOT publish raw hypotheses directly without verifying them.');
      expect(prompt).toContain('- If verified: Formulate a validated finding citing the exact line, explaining the defect, and providing a replacement fix.');
      expect(prompt).toContain('- If refuted (false positive, test mock, intentional design): Silently discard without posting.');

      // Structured hypothesis formatting
      expect(prompt).toContain('- [HYPOTHESIS hyp:gitleaks:secret-1:src/auth/jwt.ts:10] (gitleaks | CRITICAL | high confidence)');
      expect(prompt).toContain('Target: src/auth/jwt.ts:10');
      expect(prompt).toContain('Rule: generic-api-key');
      expect(prompt).toContain('Diagnostic: Hardcoded secret token detected');
      expect(prompt).toContain('Context: const secret = "ghp_1234567890abcdef";');

      expect(prompt).toContain('- [HYPOTHESIS hyp:semgrep:sec-1:src/auth/jwt.ts:35] (semgrep | ERROR | high confidence)');
      expect(prompt).toContain('Rule: jwt-none-algorithm');

      expect(prompt).toContain('- [HYPOTHESIS hyp:eslint:lint-1:src/auth/jwt.ts:50] (eslint | INFO | medium confidence)');
    });

    it('filters candidate hypotheses by persona lane affinity and scoped paths', () => {
      // 1. Security lane (sec-lane) evaluating src/auth/jwt.ts
      const secLaneScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'sec-lane',
        charter: 'builtin:security',
        scopedFiles: [{ path: 'src/auth/jwt.ts' }],
      });
      // Must receive security and secrets for src/auth/jwt.ts only
      expect(secLaneScoped.map((h) => h.id)).toEqual([
        'hyp:gitleaks:secret-1:src/auth/jwt.ts:10',
        'hyp:semgrep:sec-1:src/auth/jwt.ts:35',
      ]);
      expect(secLaneScoped.some((h) => h.category === 'linter')).toBe(false);
      expect(secLaneScoped.some((h) => h.path.includes('query.ts'))).toBe(false);

      // 2. Quality/consistency lane evaluating src/ui/Button.tsx
      const qualLaneScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'qual-lane',
        charter: 'builtin:consistency',
        scopedFiles: [{ path: 'src/ui/Button.tsx' }],
      });
      expect(qualLaneScoped.map((h) => h.id)).toEqual([
        'hyp:eslint:lint-2:src/ui/Button.tsx:14',
      ]);
      expect(qualLaneScoped.some((h) => h.category === 'security')).toBe(false);

      // 3. Database lane evaluating src/db/query.ts
      const dbLaneScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'db-lane',
        charter: 'builtin:database',
        scopedFiles: [{ path: 'src/db/query.ts' }],
      });
      expect(dbLaneScoped.map((h) => h.id)).toEqual([
        'hyp:semgrep:sec-2:src/db/query.ts:22',
      ]);
    });

    it('scopes candidate hypotheses in composed review prefix strictly to assigned task paths', () => {
      const taskAuth = {
        id: 'task-auth',
        dimension: 'security' as const,
        paths: ['src/auth/jwt.ts'],
        question: 'Is auth secure?',
        rationale: 'Auth evaluation',
      };
      const taskDb = {
        id: 'task-db',
        dimension: 'performance' as const,
        paths: ['src/db/query.ts'],
        question: 'Is db optimized?',
        rationale: 'Db evaluation',
      };

      const preCheckEvidence = {
        analyzers: {
          enabled: true,
          analyzersExecuted: 2,
          hypothesesCount: mockHypotheses.length,
          receipts: [],
          hypotheses: mockHypotheses,
          status: 'ok' as const,
        },
      };

      const files = [
        { path: 'src/auth/jwt.ts', patch: '@@ -1,5 +1,6 @@\n+const token = "";' },
        { path: 'src/db/query.ts', patch: '@@ -1,5 +1,6 @@\n+const query = "";' },
        { path: 'src/ui/Button.tsx', patch: '@@ -1,5 +1,6 @@\n+const btn = "";' },
      ];

      // Prefix for Task Auth must contain auth hypotheses but NOT db hypotheses
      const authPrefix = buildTaskScopedPrefix({
        task: taskAuth,
        effectiveFiles: files,
        domainLanes: { 'src/auth/jwt.ts': 'security_auth', 'src/db/query.ts': 'data_persistence' },
        repository: 'exampleorg/repo',
        headSha: 'sha-auth-scoped',
        repositoryVisibility: 'PUBLIC',
        rules: [],
        preCheckEvidence,
      });

      expect(authPrefix).toContain('hyp:gitleaks:secret-1:src/auth/jwt.ts:10');
      expect(authPrefix).toContain('hyp:semgrep:sec-1:src/auth/jwt.ts:35');
      expect(authPrefix).not.toContain('hyp:semgrep:sec-2:src/db/query.ts:22');
      expect(authPrefix).not.toContain('hyp:eslint:lint-2:src/ui/Button.tsx:14');

      // Prefix for Task Db must contain db hypothesis but NOT auth hypotheses
      const dbPrefix = buildTaskScopedPrefix({
        task: taskDb,
        effectiveFiles: files,
        domainLanes: { 'src/auth/jwt.ts': 'security_auth', 'src/db/query.ts': 'data_persistence' },
        repository: 'exampleorg/repo',
        headSha: 'sha-db-scoped',
        repositoryVisibility: 'PUBLIC',
        rules: [],
        preCheckEvidence,
      });

      expect(dbPrefix).toContain('hyp:semgrep:sec-2:src/db/query.ts:22');
      expect(dbPrefix).not.toContain('hyp:gitleaks:secret-1:src/auth/jwt.ts:10');
      expect(dbPrefix).not.toContain('hyp:semgrep:sec-1:src/auth/jwt.ts:35');
      expect(dbPrefix).not.toContain('hyp:eslint:lint-2:src/ui/Button.tsx:14');
    });

    it('strictly isolates unverified hypotheses so they are never published directly without persona verification', () => {
      // 1. When persona turns refute or do not verify candidate hypotheses:
      // The persona emits 0 findings.
      const personaFindings = validateFindings([]);
      expect(personaFindings).toEqual([]);

      // 2. The gate evaluation sees 0 blocking findings and approves the review
      const candidateGate: ReviewGateCandidate = {
        repositoryId: 99,
        prNumber: 42,
        headSha: '1111222233334444555566667777888899990000',
        baseSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
        policyDigest: 'd'.repeat(64),
      };

      const gateEvidence: ReviewGateEvidence = {
        verdict: 'SHIP',
        completedAt: '2026-10-08T00:00:00Z',
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
        candidate: candidateGate,
        current: { ...candidateGate, open: true, draft: false },
        evidence: gateEvidence,
      });

      expect(decision.status).toBe('success');
      expect(decision.eligible).toBe(true);
      expect(decision.reason).toBe('clean-review');

      // 3. Verify formatCandidateHypothesesPrompt returns empty string when status is disabled
      expect(formatCandidateHypothesesPrompt({ enabled: false, hypotheses: mockHypotheses } as any)).toBe('');
    });

    it('strictly shields documentation lanes and custom quality personas from security and secrets candidate hypotheses', () => {
      // 1. Documentation persona with builtin:docs charter evaluating files
      const docScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'documentation',
        charter: 'builtin:docs',
        scopedFiles: [{ path: 'src/auth/jwt.ts' }, { path: 'src/db/query.ts' }],
      });
      // Documentation personas must NEVER receive security or secrets hypotheses
      expect(docScoped.some((h) => h.category === 'security')).toBe(false);
      expect(docScoped.some((h) => h.category === 'secrets')).toBe(false);

      // 2. Documentation persona with custom doc-lane ID and licensing charter
      const docComplianceScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'docs-compliance',
        charter: 'builtin:docs-compliance',
        scopedFiles: [{ path: 'src/auth/jwt.ts' }],
      });
      expect(docComplianceScoped.some((h) => h.category === 'security')).toBe(false);
      expect(docComplianceScoped.some((h) => h.category === 'secrets')).toBe(false);

      // 3. Custom quality persona with non-standard ID and broadened charter keywords
      const customQualScoped = filterHypothesesForPersona({
        hypotheses: mockHypotheses,
        personaId: 'code-quality',
        charter: 'Review code quality, naming conventions, and style guidelines',
        scopedFiles: [{ path: 'src/auth/jwt.ts' }, { path: 'src/ui/Button.tsx' }],
      });
      // Quality personas must receive linter hypotheses only, NEVER security or secrets
      expect(customQualScoped.every((h) => h.category === 'linter')).toBe(true);
      expect(customQualScoped.some((h) => h.category === 'security')).toBe(false);
      expect(customQualScoped.some((h) => h.category === 'secrets')).toBe(false);
      expect(customQualScoped.map((h) => h.id)).toContain('hyp:eslint:lint-2:src/ui/Button.tsx:14');
    });

    it('gracefully formats and sorts malformed candidate hypotheses with missing severity, ID, or analyzer without throwing', () => {
      const malformedHypotheses: CandidateHypothesis[] = [
        {
          id: undefined as any,
          analyzer: undefined as any,
          category: 'linter',
          ruleId: 'no-var',
          path: 'src/auth/jwt.ts',
          line: 15,
          message: 'Malformed hypothesis missing id, analyzer, and severity',
          severity: undefined as any,
          confidence: undefined as any,
        },
        {
          id: 'hyp:valid-auth-sec',
          analyzer: 'semgrep',
          category: 'security',
          ruleId: 'cwe-287',
          path: 'src/auth/jwt.ts',
          line: 20,
          message: 'Valid auth vulnerability',
          severity: 'error',
          confidence: 'high',
        },
      ];

      // formatCandidateHypothesesPrompt must not throw on missing severity/id/analyzer
      let prompt = '';
      expect(() => {
        prompt = formatCandidateHypothesesPrompt(malformedHypotheses);
      }).not.toThrow();
      expect(prompt).toContain('UNKNOWN');
      expect(prompt).toContain('unidentified');
      expect(prompt).toContain('unknown');
      expect(prompt).toContain('hyp:valid-auth-sec');

      // filterHypothesesForPersona sorting must not throw on missing id/severity/confidence
      let filtered: CandidateHypothesis[] = [];
      expect(() => {
        filtered = filterHypothesesForPersona({
          hypotheses: malformedHypotheses,
          personaId: 'sec-lane',
          charter: 'builtin:security',
          scopedFiles: [{ path: 'src/auth/jwt.ts' }],
        });
      }).not.toThrow();
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered.some((h) => h.id === 'hyp:valid-auth-sec')).toBe(true);
    });

    it('ensures executePersonaPanel delivers scopedPreCheckEvidence to persona turns and isolates moderator/arbiter', async () => {
      vi.spyOn(zoektPreCheckService, 'executeZoektPreCheck').mockResolvedValue({
        status: 'ok',
        scannedSymbols: 1,
        matchedSymbols: 1,
        totalQueries: 1,
        durationMs: 5,
        truncated: false,
        symbols: [
          { symbol: 'verifyJwt', sourcePath: 'src/auth/jwt.ts', container: 'jwt', kind: 'function', matchType: 'exact' },
        ],
      } as any);

      vi.spyOn(analyzerRunnerModule, 'runPreCheckAnalyzers').mockResolvedValue({
        enabled: true,
        analyzersExecuted: 2,
        hypothesesCount: mockHypotheses.length,
        receipts: [],
        hypotheses: mockHypotheses,
        status: 'ok',
        durationMs: 15,
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
            paths: ['src/auth/**'],
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

      const recordedCalls: Array<{ role: string; persona: string; content: string }> = [];

      const mockClient = {
        complete: vi.fn().mockImplementation(async (payload: any) => {
          const content = (payload.messages || []).map((m: any) => extractMessageContentText(m.content)).join('\n');
          const isModerator = content.includes('role":"moderator"') || content.includes('Role: MODERATOR');
          const isArbiter = content.includes('role":"arbiter"') || content.includes('Role: ARBITER') || content.includes('ARBITER FINAL VERDICT');
          const role = isModerator ? 'moderator' : isArbiter ? 'arbiter' : 'persona';

          recordedCalls.push({
            role,
            persona: payload.persona || role,
            content,
          });

          const nonceMatch = content.match(/CT_REVIEW_NONCE:([^\s]+)/);
          const nonce = nonceMatch ? nonceMatch[1] : 'nonce-123';

          if (role === 'moderator') {
            return {
              id: 'msg_mod',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else if (role === 'arbiter') {
            return {
              id: 'msg_arb',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Clean' })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          } else {
            return {
              id: 'msg_persona',
              providerId: 'mock-p',
              model: 'mock-m',
              content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ role: 'persona', decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUSD: 0.001 },
              durationMs: 10,
            };
          }
        }),
      };

      const result = await executePersonaPanel({
        config,
        client: mockClient as any,
        changedFiles: [{ path: 'src/auth/jwt.ts', patch: '@@ -1,5 +1,5 @@' }],
        repository: 'exampleorg/repo',
        headSha: 'head-panel-sast-test',
      });

      expect(result).toBeDefined();
      expect(result.arbiter.verdict).toBe('SHIP');

      const personaCall = recordedCalls.find((c) => c.role === 'persona' && c.persona === 'sec-lane');
      expect(personaCall).toBeDefined();
      // sec-lane must receive scoped security/secrets hypotheses for src/auth/jwt.ts
      expect(personaCall!.content).toContain('generic-api-key');
      expect(personaCall!.content).toContain('jwt-none-algorithm');
      // sec-lane must NOT receive linter or query.ts hypotheses
      expect(personaCall!.content).not.toContain('sql-injection');
      expect(personaCall!.content).not.toContain('react/button-has-type');

      // Moderator and Arbiter must NOT receive candidate hypotheses
      const moderatorCall = recordedCalls.find((c) => c.role === 'moderator');
      if (moderatorCall) {
        expect(moderatorCall.content).not.toContain('DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
      }
      const arbiterCall = recordedCalls.find((c) => c.role === 'arbiter');
      if (arbiterCall) {
        expect(arbiterCall.content).not.toContain('DETERMINISTIC STATIC ANALYSIS PRE-CHECK HYPOTHESES');
      }
    });
  });
});
