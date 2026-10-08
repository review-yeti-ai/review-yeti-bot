import { describe, it, expect } from 'vitest';
import {
  validateFileCoverageQuorum,
  isFileCoverageSatisfied,
  type ReviewTaskPlan,
  type ReviewTaskResultV2,
  type LeanFindingSummary,
} from '../../src/reviewTaskContract';

describe('File Coverage Quorum Validator', () => {
  const plan: ReviewTaskPlan = {
    tasks: [
      {
        id: 'task-sec',
        dimension: 'security',
        paths: ['src/auth/jwt.ts'],
        question: 'Is JWT token validation safe?',
        rationale: 'Auth critical code',
      },
      {
        id: 'task-core',
        dimension: 'architecture',
        paths: ['src/services/billing.ts'],
        question: 'Is billing architecture sound?',
        rationale: 'Core transaction logic',
      },
      {
        id: 'task-style',
        dimension: 'licensing',
        paths: ['src/services/billing.ts'],
        question: 'Are licenses and headers compliant?',
        rationale: 'Style and legal compliance',
      },
      {
        id: 'task-test',
        dimension: 'testing',
        paths: ['src/services/billing.test.ts'],
        question: 'Are tests comprehensive?',
        rationale: 'Unit test suite',
      },
    ],
  };

  const changedFiles = [
    'src/auth/jwt.ts',
    'src/services/billing.ts',
    'src/services/billing.test.ts',
  ];

  it('satisfies quorum when 100% of reviewable files are covered by completed tasks', () => {
    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [] },
      { nonce: 'n3', task: 'task-style', status: 'COMPLETE', findings: [] },
      { nonce: 'n4', task: 'task-test', status: 'COMPLETE', findings: [] },
    ];

    const result = validateFileCoverageQuorum(plan, completedTasks, changedFiles);

    expect(result.satisfied).toBe(true);
    expect(result.coveragePct).toBe(100);
    expect(result.uncoveredPaths).toEqual([]);
    expect(result.coveredPaths).toEqual(expect.arrayContaining(changedFiles));
    expect(result.securityCoverageSatisfied).toBe(true);
    expect(result.missingSecurityPaths).toEqual([]);
    expect(result.verdict).toBe('SHIP');
  });

  it('survives non-critical/style task timeout when all reviewable files are covered by other tasks', () => {
    // task-style timed out or failed (omitted from completedTasks), but task-core already covers billing.ts!
    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [] },
      { nonce: 'n4', task: 'task-test', status: 'COMPLETE', findings: [] },
    ];

    const result = validateFileCoverageQuorum(plan, completedTasks, changedFiles);

    expect(result.satisfied).toBe(true);
    expect(result.coveragePct).toBe(100);
    expect(result.uncoveredPaths).toEqual([]);
    expect(result.securityCoverageSatisfied).toBe(true);
    expect(result.verdict).toBe('SHIP');
    expect(result.rationale).toContain('100% of reviewable files inspected');
  });

  it('fails quorum with coverage gap when a reviewable code file is left uninspected', () => {
    // task-test timed out and no other task covered billing.test.ts
    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [] },
    ];

    const result = validateFileCoverageQuorum(plan, completedTasks, changedFiles);

    expect(result.satisfied).toBe(false);
    expect(result.coveragePct).toBe(67);
    expect(result.uncoveredPaths).toEqual(['src/services/billing.test.ts']);
    expect(result.verdict).toBe('BLOCK');
    expect(result.status).toBe('INCOMPLETE_REVIEW');
    expect(result.rationale).toContain('File coverage incomplete (67% < 100%)');
  });

  it('enforces security floor: fails quorum if security_auth path is not reviewed by security dimension', () => {
    // Both files covered, but src/auth/jwt.ts (security_auth domain) was reviewed by architecture task, NOT security
    const nonSecPlan: ReviewTaskPlan = {
      tasks: [
        {
          id: 'task-arch-auth',
          dimension: 'architecture',
          paths: ['src/auth/jwt.ts'],
          question: 'Arch check',
          rationale: 'Arch',
        },
        {
          id: 'task-core',
          dimension: 'architecture',
          paths: ['src/services/billing.ts'],
          question: 'Core check',
          rationale: 'Core',
        },
      ],
    };

    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-arch-auth', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [] },
    ];

    const files = ['src/auth/jwt.ts', 'src/services/billing.ts'];
    const result = validateFileCoverageQuorum(nonSecPlan, completedTasks, files);

    expect(result.coveragePct).toBe(100);
    expect(result.securityCoverageSatisfied).toBe(false);
    expect(result.missingSecurityPaths).toEqual(['src/auth/jwt.ts']);
    expect(result.satisfied).toBe(false);
    expect(result.verdict).toBe('BLOCK');
    expect(result.rationale).toContain('Security floor unsatisfied: [src/auth/jwt.ts]');
  });

  it('bypasses coverage requirements for pure docs and assets and allows clean SHIP', () => {
    const nonCodeFiles = [
      'README.md',
      'docs/architecture.md',
      'assets/logo.png',
    ];

    // Zero tasks executed
    const result = validateFileCoverageQuorum({ tasks: [] }, [], nonCodeFiles);

    expect(result.satisfied).toBe(true);
    expect(result.coveragePct).toBe(100);
    expect(result.uncoveredPaths).toEqual([]);
    expect(result.coveredPaths).toEqual([]);
    expect(result.securityCoverageSatisfied).toBe(true);
    expect(result.verdict).toBe('SHIP');
    expect(result.status).toBe('COMPLETE');
    expect(result.rationale).toContain('documentation or assets');
  });

  it('requires completed source coverage for lockfiles and data in mixed diffs', () => {
    const changedFiles = ['src/api/users.ts', 'package-lock.json', 'data/seeds.json'];
    const result = validateFileCoverageQuorum({ tasks: [] }, [
      { taskId: 'api', dimension: 'contract', coveredPaths: ['src/api/users.ts'], status: 'complete' },
    ], changedFiles);
    expect(result.satisfied).toBe(false);
    expect(result.uncoveredPaths).toEqual(['package-lock.json', 'data/seeds.json']);
    expect(result.verdict).toBe('BLOCK');
  });

  it('requires lockfile and generic JSON task coverage when documentation is also changed', () => {
    const changedFiles = ['README.md', 'package-lock.json', 'mix.lock', 'go.sum', 'data/seeds.json'];
    const reviewablePaths = ['package-lock.json', 'mix.lock', 'go.sum', 'data/seeds.json'];
    const zeroTaskResult = validateFileCoverageQuorum({ tasks: [] }, [], changedFiles);

    expect(zeroTaskResult.satisfied).toBe(false);
    expect(zeroTaskResult.coveragePct).toBe(0);
    expect(zeroTaskResult.coveredPaths).toEqual([]);
    expect(zeroTaskResult.uncoveredPaths).toEqual(reviewablePaths);
    expect(zeroTaskResult.verdict).toBe('BLOCK');
    expect(zeroTaskResult.status).toBe('INCOMPLETE_REVIEW');

    const plan: ReviewTaskPlan = {
      tasks: [{
        id: 'task-dependencies',
        dimension: 'dependencies',
        paths: reviewablePaths,
        question: 'Review changed dependency and data files.',
        rationale: 'Lockfiles and structured data remain part of changed-file coverage.',
      }],
    };
    const fullyCovered = validateFileCoverageQuorum(
      plan,
      [{ nonce: 'n1', task: 'task-dependencies', status: 'COMPLETE', findings: [] }],
      changedFiles,
    );
    expect(fullyCovered.satisfied).toBe(true);
    expect(fullyCovered.coveragePct).toBe(100);
    expect(fullyCovered.coveredPaths).toEqual(reviewablePaths);
    expect(fullyCovered.uncoveredPaths).toEqual([]);
    expect(fullyCovered.verdict).toBe('SHIP');
  });

  it('supports options object signature for ergonomic caller integration', () => {
    const res = validateFileCoverageQuorum({
      changedFiles: ['src/auth/guard.ts', 'src/db/repo.ts'],
      completedTasks: [
        { taskId: 't1', dimension: 'security', coveredPaths: ['src/auth/guard.ts'], status: 'complete' },
        { taskId: 't2', dimension: 'architecture', coveredPaths: ['src/db/repo.ts'], status: 'complete' },
      ],
      minFileCoveragePct: 100,
      enforceSecurityFloor: true,
    });

    expect(res.satisfied).toBe(true);
    expect(res.coveragePct).toBe(100);
    expect(res.securityCoverageSatisfied).toBe(true);
    expect(res.uncoveredPaths).toEqual([]);
  });

  it('deduplicates overlapping task coverage without inflating counts', () => {
    const overlappingPlan: ReviewTaskPlan = {
      tasks: [
        { id: 't1', dimension: 'security', paths: ['src/auth/guard.ts', 'src/common.ts'], question: 'q1', rationale: 'r1' },
        { id: 't2', dimension: 'architecture', paths: ['src/common.ts'], question: 'q2', rationale: 'r2' },
        { id: 't3', dimension: 'testing', paths: ['src/common.ts'], question: 'q3', rationale: 'r3' },
      ],
    };

    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 't1', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 't2', status: 'COMPLETE', findings: [] },
      { nonce: 'n3', task: 't3', status: 'COMPLETE', findings: [] },
    ];

    const res = validateFileCoverageQuorum(overlappingPlan, completedTasks, ['src/auth/guard.ts', 'src/common.ts']);

    expect(res.satisfied).toBe(true);
    expect(res.coveragePct).toBe(100);
    expect(res.coveredPaths).toHaveLength(2);
    expect(res.uncoveredPaths).toEqual([]);
  });

  it('evaluates verdict to FIX_FIRST when 100% covered but P1 findings are reported', () => {
    const p1Finding: LeanFindingSummary = {
      severity: 'P1',
      file: 'src/services/billing.ts',
      line: 42,
      fingerprint: 'fp1_abcdef1234567890abcdef12',
      summary: 'Missing currency conversion rounding check.',
    };

    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [p1Finding] },
      { nonce: 'n4', task: 'task-test', status: 'COMPLETE', findings: [] },
    ];

    const result = validateFileCoverageQuorum(plan, completedTasks, changedFiles);

    expect(result.satisfied).toBe(true);
    expect(result.coveragePct).toBe(100);
    expect(result.verdict).toBe('FIX_FIRST');
    expect(result.status).toBe('COMPLETE');
  });

  it('respects configurable minFileCoveragePct threshold when partial coverage is allowed', () => {
    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [] },
      { nonce: 'n2', task: 'task-core', status: 'COMPLETE', findings: [] },
    ];

    // 2 out of 3 files = 67%
    const res80 = validateFileCoverageQuorum(plan, completedTasks, changedFiles, { minFileCoveragePct: 80 });
    expect(res80.satisfied).toBe(false);

    const res60 = validateFileCoverageQuorum(plan, completedTasks, changedFiles, { minFileCoveragePct: 60 });
    expect(res60.satisfied).toBe(true);
  });

  it('isFileCoverageSatisfied returns clean summary predicate', () => {
    const outcome = isFileCoverageSatisfied(
      [
        { task: 't1', dimension: 'security', coveredPaths: ['src/auth/jwt.ts'], status: 'complete' },
        { task: 't2', dimension: 'architecture', coveredPaths: ['src/services/billing.ts', 'src/services/billing.test.ts'], status: 'complete' },
      ],
      changedFiles,
    );

    expect(outcome.satisfied).toBe(true);
    expect(outcome.coveragePct).toBe(100);
    expect(outcome.uncoveredPaths).toEqual([]);
    expect(outcome.missingSecurityPaths).toEqual([]);
    expect(outcome.securityCoverageSatisfied).toBe(true);
  });
});
