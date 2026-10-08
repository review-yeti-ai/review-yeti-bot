import { describe, it, expect } from 'vitest';
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
import { PanelCancellationError } from '../../src/panel/panelEngine';
import { classifyPathByHeuristic, isBypassDiffOnlyPath } from '../../src/pathDomainContract';

describe('Empirical Challenger M4: Quorum Boundaries, Security Floor & Exclusion Stress Harness', () => {

  // =========================================================================
  // Challenge 1: 100% File Coverage Quorum Boundaries & Task Health
  // =========================================================================
  describe('Challenge 1: 100% File Coverage Quorum Boundaries', () => {
    const multiFilePlan: ReviewTaskPlan = {
      tasks: [
        { id: 'task-1', dimension: 'architecture', paths: ['src/a.ts'], question: 'q', rationale: 'r' },
        { id: 'task-2', dimension: 'architecture', paths: ['src/b.ts'], question: 'q', rationale: 'r' },
        { id: 'task-3', dimension: 'architecture', paths: ['src/c.ts'], question: 'q', rationale: 'r' },
        { id: 'task-4', dimension: 'architecture', paths: ['src/d.ts'], question: 'q', rationale: 'r' },
      ],
    };
    const fourFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];

    it('boundary: 3 of 4 files (75%) strictly fails quorum under default 100% threshold', () => {
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-2', status: 'COMPLETE', findings: [] },
        { nonce: 'n3', task: 'task-3', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(multiFilePlan, completed, fourFiles);
      expect(result.satisfied).toBe(false);
      expect(result.quorumSatisfied).toBe(false);
      expect(result.coveragePct).toBe(75);
      expect(result.verdict).toBe('BLOCK');
      expect(result.status).toBe('INCOMPLETE_REVIEW');
      expect(result.uncoveredPaths).toEqual(['src/d.ts']);
      expect(result.coveredPaths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    });

    it('boundary: 4 of 4 files (100%) satisfies quorum', () => {
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-2', status: 'COMPLETE', findings: [] },
        { nonce: 'n3', task: 'task-3', status: 'COMPLETE', findings: [] },
        { nonce: 'n4', task: 'task-4', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(multiFilePlan, completed, fourFiles);
      expect(result.satisfied).toBe(true);
      expect(result.quorumSatisfied).toBe(true);
      expect(result.coveragePct).toBe(100);
      expect(result.verdict).toBe('SHIP');
      expect(result.status).toBe('COMPLETE');
      expect(result.uncoveredPaths).toEqual([]);
      expect(result.coveredPaths).toHaveLength(4);
    });

    it('custom threshold: minFileCoveragePct=70 passes at 75% coverage', () => {
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-2', status: 'COMPLETE', findings: [] },
        { nonce: 'n3', task: 'task-3', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(multiFilePlan, completed, fourFiles, {
        minFileCoveragePct: 70,
      });
      expect(result.satisfied).toBe(true);
      expect(result.coveragePct).toBe(75);
      expect(result.verdict).toBe('SHIP');
    });

    it('tasks in non-healthy status (BLOCKED, ERROR, FAILED, STALLED) do NOT contribute to coverage', () => {
      const taintedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-2', status: 'BLOCKED', findings: [] },
        { nonce: 'n3', task: 'task-3', status: 'ERROR' as any, findings: [] },
        { nonce: 'n4', task: 'task-4', status: 'FAILED' as any, findings: [] },
      ];

      const result = validateFileCoverageQuorum(multiFilePlan, taintedTasks, fourFiles);
      expect(result.satisfied).toBe(false);
      expect(result.coveragePct).toBe(25);
      expect(result.uncoveredPaths).toEqual(['src/b.ts', 'src/c.ts', 'src/d.ts']);
    });

    it('overlapping tasks covering identical paths do not inflate coverage percentage', () => {
      const overlapPlan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-a1', dimension: 'architecture', paths: ['src/a.ts'], question: 'q1', rationale: 'r1' },
          { id: 'task-a2', dimension: 'performance', paths: ['src/a.ts'], question: 'q2', rationale: 'r2' },
          { id: 'task-b1', dimension: 'architecture', paths: ['src/b.ts'], question: 'q3', rationale: 'r3' },
        ],
      };

      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-a1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-a2', status: 'COMPLETE', findings: [] },
      ];

      // 2 tasks completed out of 3, but both only covered src/a.ts out of ['src/a.ts', 'src/b.ts']
      const result = validateFileCoverageQuorum(overlapPlan, completed, ['src/a.ts', 'src/b.ts']);
      expect(result.satisfied).toBe(false);
      expect(result.coveragePct).toBe(50);
      expect(result.uncoveredPaths).toEqual(['src/b.ts']);
    });

    it('resolves task paths from plan when task result omits paths and coveredPaths', () => {
      const completedWithoutExplicitPaths = [
        { id: 'task-1', status: 'complete' },
        { taskId: 'task-2', status: 'complete' },
      ];

      const result = validateFileCoverageQuorum(multiFilePlan, completedWithoutExplicitPaths as any, ['src/a.ts', 'src/b.ts']);
      expect(result.satisfied).toBe(true);
      expect(result.coveragePct).toBe(100);
      expect(result.coveredPaths).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });

  // =========================================================================
  // Challenge 2: Security Floor Enforcement
  // =========================================================================
  describe('Challenge 2: Security Floor Enforcement', () => {
    const secAndArchPlan: ReviewTaskPlan = {
      tasks: [
        { id: 'task-arch', dimension: 'architecture', paths: ['src/auth/jwt.ts', 'src/api/routes.ts'], question: 'q', rationale: 'r' },
        { id: 'task-sec', dimension: 'security', paths: ['src/auth/jwt.ts'], question: 'sec', rationale: 'sec' },
      ],
    };
    const files = ['src/auth/jwt.ts', 'src/api/routes.ts'];

    it('fails quorum if security_auth path is only inspected by non-security task (even with 100% file coverage)', () => {
      // task-arch covered both files, so file coverage is 100%
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-arch', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(secAndArchPlan, completed, files);
      expect(result.coveragePct).toBe(100);
      expect(result.securityCoverageSatisfied).toBe(false);
      expect(result.securityFloorSatisfied).toBe(false);
      expect(result.satisfied).toBe(false);
      expect(result.quorumSatisfied).toBe(false);
      expect(result.missingSecurityPaths).toEqual(['src/auth/jwt.ts']);
      expect(result.rationale).toContain('Security floor unsatisfied: [src/auth/jwt.ts]');
      expect(result.verdict).toBe('BLOCK');
    });

    it('passes quorum when security task inspects the security_auth path', () => {
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-arch', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 'task-sec', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(secAndArchPlan, completed, files);
      expect(result.coveragePct).toBe(100);
      expect(result.securityCoverageSatisfied).toBe(true);
      expect(result.securityFloorSatisfied).toBe(true);
      expect(result.satisfied).toBe(true);
      expect(result.missingSecurityPaths).toEqual([]);
      expect(result.verdict).toBe('SHIP');
    });

    it('multiple security paths: fails if any security_auth path is missing security inspection', () => {
      const twoSecFiles = ['src/auth/jwt.ts', 'src/security/firewall.ts'];
      const plan: ReviewTaskPlan = {
        tasks: [
          { id: 't-sec1', dimension: 'security', paths: ['src/auth/jwt.ts'], question: 'q', rationale: 'r' },
          { id: 't-perf', dimension: 'performance', paths: ['src/security/firewall.ts'], question: 'q', rationale: 'r' },
        ],
      };
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 't-sec1', status: 'COMPLETE', findings: [] },
        { nonce: 'n2', task: 't-perf', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(plan, completed, twoSecFiles);
      expect(result.coveragePct).toBe(100);
      expect(result.securityCoverageSatisfied).toBe(false);
      expect(result.missingSecurityPaths).toEqual(['src/security/firewall.ts']);
      expect(result.satisfied).toBe(false);
    });

    it('enforceSecurityFloor: false allows quorum pass even when security floor is unsatisfied', () => {
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-arch', status: 'COMPLETE', findings: [] },
      ];

      const result = validateFileCoverageQuorum(secAndArchPlan, completed, files, {
        enforceSecurityFloor: false,
      });
      expect(result.coveragePct).toBe(100);
      expect(result.securityCoverageSatisfied).toBe(true);
      expect(result.satisfied).toBe(true);
      expect(result.verdict).toBe('SHIP');
    });

    it('markdown docs with security names do not trigger security_auth classification', () => {
      expect(classifyPathByHeuristic('docs/security-architecture.md')).toBe('docs_assets');
      expect(classifyPathByHeuristic('session-skill-retro/SKILL.md')).toBe('docs_assets');
      expect(classifyPathByHeuristic('docs/oauth-guide.markdown')).toBe('docs_assets');

      // Since classified as docs_assets, validateFileCoverageQuorum does NOT demand a security task
      const result = validateFileCoverageQuorum({ tasks: [] }, [], ['docs/security-architecture.md']);
      expect(result.satisfied).toBe(true);
      expect(result.securityCoverageSatisfied).toBe(true);
      expect(result.missingSecurityPaths).toEqual([]);
    });

    it('sensitive secrets and certificates trigger security_auth classification', () => {
      expect(classifyPathByHeuristic('.env.production')).toBe('security_auth');
      expect(classifyPathByHeuristic('certs/server.key')).toBe('security_auth');
      expect(classifyPathByHeuristic('config/jwt_policy.yaml')).toBe('security_auth');
      expect(classifyPathByHeuristic('lib/web/plug/auth.ex')).toBe('security_auth');
    });
  });

  // =========================================================================
  // Challenge 3: Path Filter Exclusion & effectiveFilePaths
  // =========================================================================
  describe('Challenge 3: Path Filter Exclusion & effectiveFilePaths Integration', () => {
    it('simulates path_filters: excluded files omitted from effectiveFilePaths pass quorum cleanly', () => {
      // Changed files in PR includes 1 modified app file and 3 excluded generated/vendor files
      const allChangedFiles = [
        'src/components/Header.tsx',
        'generated/graphql.types.ts',
        'vendor/bundle.js',
        'build/output.js',
      ];

      // Repository path_filters exclude generated/**, vendor/**, build/**
      const effectiveFilePaths = ['src/components/Header.tsx'];

      const plan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-ui', dimension: 'architecture', paths: ['src/components/Header.tsx'], question: 'UI', rationale: 'UI' },
        ],
      };
      const completed: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-ui', status: 'COMPLETE', findings: [] },
      ];

      // When passing effectiveFilePaths (as composedEngine.ts now does):
      const effectiveQuorum = validateFileCoverageQuorum(plan, completed, effectiveFilePaths);
      expect(effectiveQuorum.satisfied).toBe(true);
      expect(effectiveQuorum.coveragePct).toBe(100);
      expect(effectiveQuorum.verdict).toBe('SHIP');

      // Contrast with passing raw changedFiles (the old buggy behavior in composedEngine):
      const rawQuorum = validateFileCoverageQuorum(plan, completed, allChangedFiles);
      expect(rawQuorum.satisfied).toBe(false);
      expect(rawQuorum.coveragePct).toBe(25);
      expect(rawQuorum.verdict).toBe('BLOCK');
      expect(rawQuorum.uncoveredPaths).toEqual([
        'generated/graphql.types.ts',
        'vendor/bundle.js',
        'build/output.js',
      ]);
    });

    it('supports object-form planOrOptions contract with effective paths and active findings', () => {
      const result = validateFileCoverageQuorum({
        plan: {
          tasks: [{ id: 't1', dimension: 'architecture', paths: ['src/index.ts'], question: 'q', rationale: 'r' }],
        },
        changedFiles: ['src/index.ts'],
        completedTasks: [{ nonce: 'n1', task: 't1', status: 'COMPLETE', findings: [] } as any],
        minFileCoveragePct: 100,
        enforceSecurityFloor: true,
      });

      expect(result.satisfied).toBe(true);
      expect(result.coveragePct).toBe(100);
      expect(result.verdict).toBe('SHIP');
    });
  });

  // =========================================================================
  // Challenge 4: Documentation and Asset Exclusion; Lockfile Coverage
  // =========================================================================
  describe('Challenge 4: Documentation and Asset Exclusion; Lockfile Coverage', () => {
    it('isBypassDiffOnlyPath accurately recognizes lockfiles and non-config json', () => {
      expect(isBypassDiffOnlyPath('package-lock.json')).toBe(true);
      expect(isBypassDiffOnlyPath('yarn.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('pnpm-lock.yaml')).toBe(true);
      expect(isBypassDiffOnlyPath('mix.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('cargo.lock')).toBe(true);
      expect(isBypassDiffOnlyPath('go.sum')).toBe(true);
      expect(isBypassDiffOnlyPath('data/fixtures.json')).toBe(true);

      // Crucial exceptions that MUST NOT bypass:
      expect(isBypassDiffOnlyPath('package.json')).toBe(false);
      expect(isBypassDiffOnlyPath('tsconfig.json')).toBe(false);
      expect(isBypassDiffOnlyPath('src/main.ts')).toBe(false);
    });

    it('pure documentation and asset PRs satisfy quorum with 0 tasks and SHIP verdict', () => {
      const pureDocs = [
        'README.md',
        'docs/setup.md',
        'docs/architecture.png',
        'assets/banner.webp',
        'LICENSE',
        '.gitignore',
      ];

      const result = validateFileCoverageQuorum({ tasks: [] }, [], pureDocs);
      expect(result.satisfied).toBe(true);
      expect(result.coveragePct).toBe(100);
      expect(result.verdict).toBe('SHIP');
      expect(result.status).toBe('COMPLETE');
      expect(result.rationale).toContain('All changed files are documentation or assets');
    });

    it('pure lockfile updates require task coverage', () => {
      const pureLockfiles = ['package-lock.json', 'mix.lock', 'go.sum'];
      const zeroTask = validateFileCoverageQuorum({ tasks: [] }, [], pureLockfiles);
      expect(zeroTask.satisfied).toBe(false);
      expect(zeroTask.coveragePct).toBe(0);
      expect(zeroTask.verdict).toBe('BLOCK');
      expect(zeroTask.status).toBe('INCOMPLETE_REVIEW');
      expect(zeroTask.uncoveredPaths).toEqual(pureLockfiles);

      const plan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-lockfiles', dimension: 'dependencies', paths: pureLockfiles, question: 'lockfiles', rationale: 'lockfiles' },
        ],
      };
      const covered = validateFileCoverageQuorum(
        plan,
        [{ nonce: 'n1', task: 'task-lockfiles', status: 'COMPLETE', findings: [] }],
        pureLockfiles,
      );
      expect(covered.satisfied).toBe(true);
      expect(covered.coveragePct).toBe(100);
      expect(covered.verdict).toBe('SHIP');
      expect(covered.coveredPaths).toEqual(pureLockfiles);
    });

    it('mixed PR: documentation is excluded while code and lockfiles require task coverage', () => {
      const mixedFiles = ['src/core.ts', 'README.md', 'package-lock.json', 'docs/api.md'];
      const codeOnlyPlan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-core', dimension: 'architecture', paths: ['src/core.ts'], question: 'core', rationale: 'core' },
        ],
      };

      // A task that only covers code leaves the lockfile unreviewed.
      const codeOnlyRun = validateFileCoverageQuorum(
        codeOnlyPlan,
        [{ nonce: 'n1', task: 'task-core', status: 'COMPLETE', findings: [] }],
        mixedFiles,
      );
      expect(codeOnlyRun.satisfied).toBe(false);
      expect(codeOnlyRun.coveragePct).toBe(50);
      expect(codeOnlyRun.coveredPaths).toEqual(['src/core.ts']);
      expect(codeOnlyRun.uncoveredPaths).toEqual(['package-lock.json']);

      const completePlan: ReviewTaskPlan = {
        tasks: [
          { id: 'task-core', dimension: 'architecture', paths: ['src/core.ts', 'package-lock.json'], question: 'core and lockfile', rationale: 'review both paths' },
        ],
      };
      const completeRun = validateFileCoverageQuorum(
        completePlan,
        [{ nonce: 'n1', task: 'task-core', status: 'COMPLETE', findings: [] }],
        mixedFiles,
      );
      expect(completeRun.satisfied).toBe(true);
      expect(completeRun.coveragePct).toBe(100);
      expect(completeRun.coveredPaths).toEqual(['src/core.ts', 'package-lock.json']);
      expect(completeRun.uncoveredPaths).toEqual([]);

      const incompleteRun = validateFileCoverageQuorum(codeOnlyPlan, [], mixedFiles);
      expect(incompleteRun.satisfied).toBe(false);
      expect(incompleteRun.coveragePct).toBe(0);
      expect(incompleteRun.uncoveredPaths).toEqual(['src/core.ts', 'package-lock.json']);
    });

    it('pure docs PR with active P1 finding yields FIX_FIRST verdict while keeping quorum satisfied', () => {
      const p1: LeanFindingSummary = {
        severity: 'P1',
        file: 'README.md',
        line: 10,
        fingerprint: 'fp_readme_p1',
        summary: 'Exposed internal URL in public documentation.',
      };

      const result = validateFileCoverageQuorum(
        { tasks: [] },
        [],
        ['README.md'],
        { activeFindings: [p1] },
      );

      expect(result.satisfied).toBe(true);
      expect(result.quorumSatisfied).toBe(true);
      expect(result.verdict).toBe('FIX_FIRST');
      expect(result.status).toBe('COMPLETE');
    });
  });

  // =========================================================================
  // Challenge 5: Blocker Fast-Path Quorum & Finding Path Normalization
  // =========================================================================
  describe('Challenge 5: Blocker Fast-Path Quorum & Finding Path Normalization', () => {
    it('verified P0 with file property formats file:line in rationale', () => {
      const p0WithFile: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/jwt.ts',
        line: 42,
        fingerprint: 'fp_p0_1',
        summary: 'Hardcoded secret token in auth module.',
      };

      const result = validateFileCoverageQuorum(
        { tasks: [] },
        [],
        ['src/auth/jwt.ts', 'src/other.ts'],
        { activeFindings: [p0WithFile] },
      );

      expect(result.satisfied).toBe(true);
      expect(result.mode).toBe('blocker_fast_path');
      expect(result.verdict).toBe('BLOCK');
      expect(result.status).toBe('BLOCKER_EXIT');
      expect(result.blockerFastPath).toBe(true);
      expect(result.rationale).toBe('P0 Blocker detected on src/auth/jwt.ts:42. Fast-path early-exit triggered.');
    });

    it('verified P0 with path property (persona hydration format) formats path:line in rationale without undefined', () => {
      const p0WithPath = {
        severity: 'P0' as const,
        path: 'src/crypto/aes.ts',
        line: 99,
        fingerprint: 'fp_p0_2',
        summary: 'ECB mode used for block cipher encryption.',
      };

      const result = validateFileCoverageQuorum(
        { tasks: [] },
        [],
        ['src/crypto/aes.ts'],
        { activeFindings: [p0WithPath as any] },
      );

      expect(result.satisfied).toBe(true);
      expect(result.blockerFastPath).toBe(true);
      expect(result.rationale).toBe('P0 Blocker detected on src/crypto/aes.ts:99. Fast-path early-exit triggered.');
      expect(result.rationale).not.toContain('undefined');
    });

    it('verified P0 with missing path/file falls back to unknown:line without throwing', () => {
      const p0WithoutPath = {
        severity: 'P0' as const,
        line: 12,
        fingerprint: 'fp_p0_3',
        summary: 'Missing path defect.',
      };

      const result = validateFileCoverageQuorum(
        { tasks: [] },
        [],
        ['src/main.ts'],
        { activeFindings: [p0WithoutPath as any] },
      );

      expect(result.satisfied).toBe(true);
      expect(result.rationale).toBe('P0 Blocker detected on unknown:12. Fast-path early-exit triggered.');
    });

    it('P0 blocker overrides 0% coverage and security floor failures', () => {
      const p0: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/login.ts',
        line: 1,
        fingerprint: 'fp_p0_zero_cov',
        summary: 'Root backdoor.',
      };

      // 0 tasks completed on 5 files, including security files
      const result = validateFileCoverageQuorum(
        { tasks: [] },
        [],
        ['src/auth/login.ts', 'src/db/repo.ts', 'src/api/handler.ts'],
        { activeFindings: [p0] },
      );

      expect(result.satisfied).toBe(true);
      expect(result.quorumSatisfied).toBe(true);
      expect(result.mode).toBe('blocker_fast_path');
      expect(result.verdict).toBe('BLOCK');
      expect(result.status).toBe('BLOCKER_EXIT');
      expect(result.securityCoverageSatisfied).toBe(true);
      expect(result.securityFloorSatisfied).toBe(true);
    });

    it('PanelCancellationError is correctly identified and distinct from unhandled errors', () => {
      const cancelError = new PanelCancellationError('blocker_fast_path');
      expect(cancelError).toBeInstanceOf(PanelCancellationError);
      expect(cancelError).toBeInstanceOf(Error);
      expect(cancelError.name).toBe('PanelCancellationError');
      expect(cancelError.message).toBe('blocker_fast_path');

      // Verify that the composed engine guard works as expected:
      const isCleanCancel = (err: any) => err instanceof PanelCancellationError;
      expect(isCleanCancel(cancelError)).toBe(true);
      expect(isCleanCancel(new Error('regular error'))).toBe(false);
      expect(isCleanCancel(new TypeError('type error'))).toBe(false);
    });
  });

  // =========================================================================
  // Challenge 6: Configuration Schema Defaults & Robustness
  // =========================================================================
  describe('Challenge 6: Configuration Schema Defaults & Robustness', () => {
    it('keeps absent quorum policy for legacy fallback and defaults explicit policy fields', () => {
      // Absence keeps the legacy all-task behavior selected by the composed engine.
      const legacy = composedEngineConfigSchema.parse({});
      expect(legacy.quorum_policy).toBeUndefined();

      const explicitDefaults = composedEngineConfigSchema.parse({ quorum_policy: {} });
      expect(explicitDefaults.quorum_policy?.mode).toBe('file_coverage');
      expect(explicitDefaults.quorum_policy?.min_file_coverage_pct).toBe(100);
      expect(explicitDefaults.quorum_policy?.enforce_security_floor).toBe(true);
      expect(explicitDefaults.quorum_policy?.blocker_fast_path_enabled).toBe(true);

      const explicitMode = composedEngineConfigSchema.parse({ quorum_policy: { mode: 'all_tasks' } });
      expect(explicitMode.quorum_policy?.mode).toBe('all_tasks');
      expect(explicitMode.quorum_policy?.min_file_coverage_pct).toBe(100);
      expect(explicitMode.quorum_policy?.enforce_security_floor).toBe(true);
      expect(explicitMode.quorum_policy?.blocker_fast_path_enabled).toBe(true);

      // Rejects unknown property in strict schema
      expect(() =>
        composedEngineConfigSchema.parse({
          invalid_key: 123,
        } as any),
      ).toThrow();

      // Rejects out-of-range min_file_coverage_pct
      expect(() =>
        composedEngineConfigSchema.parse({
          quorum_policy: {
            mode: 'file_coverage',
            min_file_coverage_pct: 150,
          },
        }),
      ).toThrow();
    });
  });
});
