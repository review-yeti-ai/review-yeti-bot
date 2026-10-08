import { describe, it, expect, vi } from 'vitest';
import {
  validateFileCoverageQuorum,
  type ReviewTaskPlan,
  type ReviewTaskResultV2,
  type LeanFindingSummary,
} from '../../src/reviewTaskContract';
import {
  evaluateReviewGate,
  type ReviewGateEvidence,
  type ReviewGateCandidate,
} from '../../src/review/reviewGatePolicy';
import { computeArbitration } from '../../src/review/reviewCore';
import {
  projectPublishingRosterBounds,
  publishingConclusion,
} from '../../src/cli/publishingReview';
import { PanelCancellationError } from '../../src/panel/panelErrors';
import {
  deriveCanonicalWorkerReviewEvidence,
  type WorkerReviewCompletion,
  type TrustedReviewCoverageContract,
} from '../../src/review/workerReviewCompletion';

describe('Adversarial Challenger Suite: Milestone 4 Quorum, Fast-Path, Cancellation & Publishing', () => {
  const candidate: ReviewGateCandidate = {
    repositoryId: 42,
    prNumber: 999,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    policyDigest: 'c'.repeat(64),
  };
  const current = { ...candidate, open: true, draft: false };

  // =========================================================================
  // Challenge 1: Simultaneous P0 Findings Emitted Across Parallel Tasks
  // =========================================================================
  describe('Challenge 1: Simultaneous P0 Findings Deduplication & Race Cleanliness', () => {
    it('deduplicates identical P0 findings emitted by multiple parallel tasks without inflating counts', () => {
      const p0Same: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/session.ts',
        line: 42,
        fingerprint: 'fp1_same_p0_hash_abcdef123456',
        summary: 'Session token validation completely disabled in production handler.',
      };

      const parallelTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'sec-lane-1', status: 'COMPLETE', findings: [p0Same] },
        { nonce: 'n2', task: 'sec-lane-2', status: 'COMPLETE', findings: [p0Same] },
        { nonce: 'n3', task: 'audit-lane', status: 'COMPLETE', findings: [p0Same] },
      ];

      const plan: ReviewTaskPlan = {
        tasks: [
          { id: 'sec-lane-1', dimension: 'security', paths: ['src/auth/session.ts'], question: 'Sec 1', rationale: 'Sec 1' },
          { id: 'sec-lane-2', dimension: 'security', paths: ['src/auth/session.ts'], question: 'Sec 2', rationale: 'Sec 2' },
          { id: 'audit-lane', dimension: 'compliance', paths: ['src/auth/session.ts'], question: 'Audit', rationale: 'Audit' },
          { id: 'unexecuted-1', dimension: 'perf', paths: ['src/perf.ts'], question: 'Perf', rationale: 'Perf' },
        ],
      };

      const quorum = validateFileCoverageQuorum(
        plan,
        parallelTasks,
        ['src/auth/session.ts', 'src/perf.ts'],
        { activeFindings: [p0Same, p0Same] },
      );

      expect(quorum.satisfied).toBe(true);
      expect(quorum.blockerFastPath).toBe(true);
      expect(quorum.verdict).toBe('BLOCK');
      expect(quorum.status).toBe('BLOCKER_EXIT');

      // Now verify arbitration deduplication
      const rawPersonas = [
        {
          id: 'sec-lane-1',
          status: 'COMPLETE',
          findings: [
            {
              severity: 'P0' as const,
              path: 'src/auth/session.ts',
              line: 42,
              title: 'Disabled validation',
              body: 'Disables session check',
            },
          ],
        },
        {
          id: 'sec-lane-2',
          status: 'COMPLETE',
          findings: [
            {
              severity: 'P0' as const,
              path: 'src/auth/session.ts',
              line: 42,
              title: 'Disabled validation',
              body: 'Disables session check',
            },
          ],
        },
      ];

      const arbitration = computeArbitration(rawPersonas, 4, {
        changedFiles: [{ path: 'src/auth/session.ts' }, { path: 'src/perf.ts' }],
        coverageComplete: true,
        blockerFastPath: true,
      });

      expect(arbitration.quorumSatisfied).toBe(true);
      expect(arbitration.verdict).toBe('BLOCK');
      // Deduplicated unique findings
      expect(arbitration.metrics.p0Count).toBe(1);
      expect(arbitration.findings.length).toBe(1);
    });

    it('aggregates distinct simultaneous P0 findings across different files accurately', () => {
      const p0Auth: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/auth/token.ts',
        line: 10,
        fingerprint: 'fp1_p0_auth_hash',
        summary: 'Hardcoded JWT secret.',
      };
      const p0Db: LeanFindingSummary = {
        severity: 'P0',
        file: 'src/db/migrate.ts',
        line: 99,
        fingerprint: 'fp1_p0_db_hash',
        summary: 'DROP DATABASE in migration script.',
      };

      const parallelTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [p0Auth] },
        { nonce: 'n2', task: 'task-db', status: 'COMPLETE', findings: [p0Db] },
      ];

      const quorum = validateFileCoverageQuorum(
        {
          tasks: [
            { id: 'task-sec', dimension: 'security', paths: ['src/auth/token.ts'], question: 'Sec', rationale: 'Sec' },
            { id: 'task-db', dimension: 'architecture', paths: ['src/db/migrate.ts'], question: 'Db', rationale: 'Db' },
          ],
        },
        parallelTasks,
        ['src/auth/token.ts', 'src/db/migrate.ts', 'src/unreviewed.ts'],
        { activeFindings: [p0Auth, p0Db] },
      );

      expect(quorum.satisfied).toBe(true);
      expect(quorum.blockerFastPath).toBe(true);
      expect(quorum.verdict).toBe('BLOCK');

      const arbitration = computeArbitration(
        [
          { id: 'task-sec', status: 'COMPLETE', findings: [{ severity: 'P0', path: 'src/auth/token.ts', line: 10, title: 'T1', body: 'B1' }] },
          { id: 'task-db', status: 'COMPLETE', findings: [{ severity: 'P0', path: 'src/db/migrate.ts', line: 99, title: 'T2', body: 'B2' }] },
        ],
        3,
        {
          changedFiles: [{ path: 'src/auth/token.ts' }, { path: 'src/db/migrate.ts' }, { path: 'src/unreviewed.ts' }],
          coverageComplete: true,
          blockerFastPath: true,
        },
      );

      expect(arbitration.metrics.p0Count).toBe(2);
      expect(arbitration.verdict).toBe('BLOCK');
      expect(arbitration.status).toBe('BLOCK');
    });
  });

  // =========================================================================
  // Challenge 2: Non-Blocking P1/P2 Findings Must NOT Trigger Early Exit
  // =========================================================================
  describe('Challenge 2: P1/P2 Findings Gating & File Coverage Protection', () => {
    it('high-volume P1/P2 findings do NOT trigger blocker fast-path early exit', () => {
      const p1Findings: LeanFindingSummary[] = Array.from({ length: 15 }, (_, i) => ({
        severity: 'P1',
        file: 'src/api/routes.ts',
        line: i + 1,
        fingerprint: `fp1_p1_sample_${i}`,
        summary: `Moderate flaw ${i}`,
      }));

      const p2Findings: LeanFindingSummary[] = Array.from({ length: 30 }, (_, i) => ({
        severity: 'P2',
        file: 'src/api/routes.ts',
        line: i + 50,
        fingerprint: `fp1_p2_sample_${i}`,
        summary: `Minor flaw ${i}`,
      }));

      const completedTasks: ReviewTaskResultV2[] = [
        { nonce: 'n1', task: 'api-lane', status: 'COMPLETE', findings: [...p1Findings, ...p2Findings] },
      ];

      const plan: ReviewTaskPlan = {
        tasks: [
          { id: 'api-lane', dimension: 'architecture', paths: ['src/api/routes.ts'], question: 'API', rationale: 'API' },
          { id: 'sec-lane', dimension: 'security', paths: ['src/auth/jwt.ts'], question: 'Sec', rationale: 'Sec' },
        ],
      };

      // Two files changed; only one inspected.
      const quorum = validateFileCoverageQuorum(
        plan,
        completedTasks,
        ['src/api/routes.ts', 'src/auth/jwt.ts'],
        { activeFindings: [...p1Findings, ...p2Findings] },
      );

      // Must NOT trigger blocker fast path!
      expect(quorum.blockerFastPath).toBe(false);
      // Must FAIL quorum because src/auth/jwt.ts is uninspected!
      expect(quorum.satisfied).toBe(false);
      expect(quorum.uncoveredPaths).toEqual(['src/auth/jwt.ts']);
      expect(quorum.coveragePct).toBe(50);
      expect(quorum.verdict).toBe('BLOCK');
      expect(quorum.status).toBe('INCOMPLETE_REVIEW');
    });

    it('P1 finding on 100% covered files yields FIX_FIRST verdict, not BLOCK or early exit', () => {
      const p1: LeanFindingSummary = {
        severity: 'P1',
        file: 'src/index.ts',
        line: 5,
        fingerprint: 'fp1_p1_lone',
        summary: 'Unhandled promise rejection in export.',
      };

      const quorum = validateFileCoverageQuorum(
        { tasks: [{ id: 't1', dimension: 'architecture', paths: ['src/index.ts'], question: 'Q', rationale: 'R' }] },
        [{ nonce: 'n1', task: 't1', status: 'COMPLETE', findings: [p1] }],
        ['src/index.ts'],
        { activeFindings: [p1] },
      );

      expect(quorum.blockerFastPath).toBe(false);
      expect(quorum.satisfied).toBe(true);
      expect(quorum.coveragePct).toBe(100);
      expect(quorum.verdict).toBe('FIX_FIRST');
      expect(quorum.status).toBe('COMPLETE');
    });

    it('security floor failure cannot be bypassed by high-volume P1/P2 findings in non-security lanes', () => {
      const completedTasks: ReviewTaskResultV2[] = [
        {
          nonce: 'n1',
          task: 'perf-lane',
          status: 'COMPLETE',
          findings: [{ severity: 'P1', file: 'src/auth/login.ts', line: 10, fingerprint: 'fp1_x', summary: 'Slow query' }],
        },
      ];

      const quorum = validateFileCoverageQuorum(
        { tasks: [{ id: 'perf-lane', dimension: 'performance', paths: ['src/auth/login.ts'], question: 'Perf', rationale: 'Perf' }] },
        completedTasks,
        ['src/auth/login.ts'],
        { enforceSecurityFloor: true },
      );

      // Even though all files were visited by perf, security floor demands security dimension
      expect(quorum.satisfied).toBe(false);
      expect(quorum.securityCoverageSatisfied).toBe(false);
      expect(quorum.missingSecurityPaths).toEqual(['src/auth/login.ts']);
      expect(quorum.blockerFastPath).toBe(false);
    });
  });

  // =========================================================================
  // Challenge 3: Abort Signal Propagation & Cancellation Cleanliness
  // =========================================================================
  describe('Challenge 3: Abort Signal Propagation & Error Hierarchy', () => {
    it('properly distinguishes PanelCancellationError from fatal internal failures', () => {
      const cancellation = new PanelCancellationError('blocker_fast_path');
      expect(cancellation).toBeInstanceOf(PanelCancellationError);
      expect(cancellation).toBeInstanceOf(Error);
      expect(cancellation.name).toBe('PanelCancellationError');

      // Normal internal errors must NOT be instances of PanelCancellationError
      const unexpectedError = new Error('Database connection lost');
      expect(unexpectedError instanceof PanelCancellationError).toBe(false);
    });

    it('aborts multiple concurrent listeners immediately upon P0 trigger without dangling timers', async () => {
      const controller = new AbortController();
      let listenerCount = 0;
      let abortedCount = 0;

      const createStreamingTask = (id: number) => {
        listenerCount += 1;
        return new Promise<string>((resolve) => {
          if (controller.signal.aborted) {
            abortedCount += 1;
            resolve(`aborted-${id}`);
            return;
          }
          controller.signal.addEventListener(
            'abort',
            () => {
              abortedCount += 1;
              resolve(`aborted-${id}`);
            },
            { once: true },
          );
        });
      };

      const tasks = [createStreamingTask(1), createStreamingTask(2), createStreamingTask(3), createStreamingTask(4)];

      // Trigger abort with PanelCancellationError
      controller.abort(new PanelCancellationError('blocker_fast_path'));

      const results = await Promise.all(tasks);
      expect(results).toEqual(['aborted-1', 'aborted-2', 'aborted-3', 'aborted-4']);
      expect(abortedCount).toBe(listenerCount);
      expect(abortedCount).toBe(4);
    });
  });

  // =========================================================================
  // Challenge 4: Publishing Roster Bounds Projection on Blocker Fast-Path
  // =========================================================================
  describe('Challenge 4: Publishing Roster Bounds Projection & Gate Decision', () => {
    it('projectPublishingRosterBounds treats aborted/missing lanes as benign on blockerFastPath', () => {
      const mockFastPathResult = {
        applicablePersonaIds: ['lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5'],
        personas: [
          {
            id: 'lane-1',
            status: 'COMPLETE',
            findings: [{ severity: 'P0', path: 'src/main.ts', line: 1, title: 'Crash', body: 'Crash' }],
          },
        ],
        optionalFailures: [],
        blockerFastPath: true,
        quorum: { required: 1, distinctProviders: ['test'], satisfied: true, blockerFastPath: true },
      } as any;

      const bounds = projectPublishingRosterBounds(mockFastPathResult);

      expect(bounds.completedLaneCount).toBe(1);
      expect(bounds.failedLaneCount).toBe(0);
      expect(bounds.missingConfiguredLaneCount).toBe(0);
      expect(bounds.malformedReturnedLaneCount).toBe(0);
    });

    it('projectPublishingRosterBounds marks missing lanes as errors when blockerFastPath is FALSE', () => {
      const mockNormalIncompleteResult = {
        applicablePersonaIds: ['lane-1', 'lane-2', 'lane-3'],
        personas: [
          {
            id: 'lane-1',
            status: 'COMPLETE',
            findings: [],
          },
        ],
        optionalFailures: [],
        blockerFastPath: false,
        quorum: { required: 1, distinctProviders: ['test'], satisfied: false },
      } as any;

      const bounds = projectPublishingRosterBounds(mockNormalIncompleteResult);

      expect(bounds.completedLaneCount).toBe(1);
      expect(bounds.missingConfiguredLaneCount).toBe(2);
    });

    it('evaluateReviewGate decisively blocks with blocking-findings on blockerFastPath evidence', () => {
      const fastPathEvidence: ReviewGateEvidence = {
        verdict: 'BLOCK',
        completedAt: '2026-10-08T00:30:00Z',
        coverageComplete: false, // Incomplete coverage is normal when early exit aborts lanes
        quorumSatisfied: true,
        infrastructureFailure: false,
        p0Count: 1,
        p1Count: 0,
        p2Count: 0,
        expectedLanes: 5,
        completedLanes: 1,
        blockerFastPath: true,
      };

      const decision = evaluateReviewGate({ candidate, current, evidence: fastPathEvidence });
      expect(decision.status).toBe('failure');
      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe('blocking-findings');
    });

    it('publishingConclusion returns failure on BLOCK regardless of lane count', () => {
      expect(publishingConclusion('BLOCK', 1)).toBe('failure');
      expect(publishingConclusion('BLOCK', 0)).toBe('failure');
    });
  });

  // =========================================================================
  // Challenge 5: Blocker Fast-Path Canonical Evidence & Gate Fail-Closed Contract
  // =========================================================================
  describe('Challenge 5: Blocker Fast-Path Canonical Evidence & Gate Contract', () => {
    const trustedCoordinates = {
      runId: 'run_' + 'a'.repeat(32),
      repositoryId: 42,
      owner: 'exampleorg',
      repo: 'example-api',
      prNumber: 999,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
      executionAttempt: 1,
    };

    const changedFiles = [
      { path: 'src/auth/session.ts', patch: '@@ -1,0 +1,5 @@\n+const token = req.token;\n' },
      { path: 'src/db/query.ts', patch: '@@ -1,0 +1,5 @@\n+const res = db.query();\n' },
    ];

    const plannedTasks = [
      { id: 'task-sec', dimension: 'security' as const, paths: ['src/auth/session.ts'], question: 'Sec?', rationale: 'Sec' },
      { id: 'task-db', dimension: 'architecture' as const, paths: ['src/db/query.ts'], question: 'Db?', rationale: 'Db' },
      { id: 'task-perf', dimension: 'performance' as const, paths: ['src/db/query.ts'], question: 'Perf?', rationale: 'Perf' },
    ];

    it('deriveCanonicalWorkerReviewEvidence validates WorkerReviewResult.v1 on P0 blocker fast-path without false coverage refusal', () => {
      // In a real P0 blocker fast-path run, task-sec finds a P0 defect and remaining tasks are halted.
      // Therefore, coverageComplete is FALSE, but quorumSatisfied is TRUE in the worker result.
      const completion: WorkerReviewCompletion = {
        version: 'WorkerReviewCompletion.v1',
        ...trustedCoordinates,
        result: {
          version: 'WorkerReviewResult.v1',
          completedAt: '2026-10-08T01:00:00.000Z',
          personas: [
            {
              id: 'task-sec',
              decision: 'FINDINGS',
              status: 'COMPLETE',
              findings: [
                {
                  severity: 'P0',
                  path: 'src/auth/session.ts',
                  line: 1,
                  title: 'Critical auth bypass in session',
                  body: 'Unauthenticated requests bypass security checks.',
                },
              ],
            },
          ],
          taskPlan: plannedTasks,
          coverageComplete: false, // Accurately false: other planned tasks did not run
          quorumSatisfied: true,   // Worker self-reports quorum satisfied on blocker fast path
          verdict: 'BLOCK',
          findingCount: 1,
          blockingFindingCount: 1,
        },
      };

      const trustedContract: TrustedReviewCoverageContract = {
        expectedCoordinates: trustedCoordinates,
        expectedPersonaIds: ['task-sec', 'task-db', 'task-perf'],
        changedFiles,
        coverageComplete: true, // Trusted contract admits coverage evaluation
        quorumSatisfied: true,
        reviewEngine: 'composed',
        composedChangedPaths: ['src/auth/session.ts', 'src/db/query.ts'],
        composedMaxTasks: 8,
      };

      const derivation = deriveCanonicalWorkerReviewEvidence(completion, trustedContract);

      // Must validate cleanly WITHOUT throwing false coverage refusal errors
      expect(derivation.valid).toBe(true);
      if (!derivation.valid) throw new Error(`Unexpected failure: ${derivation.message}`);

      expect(derivation.evidence).toMatchObject({
        verdict: 'BLOCK',
        p0Count: 1,
        expectedLanes: 3,
        completedLanes: 1,
        coverageComplete: false,
      });

      // When tagged with blockerFastPath on evidence (or quorum satisfied with P0):
      const fastPathDecision = evaluateReviewGate({
        candidate,
        current,
        evidence: {
          ...derivation.evidence,
          blockerFastPath: true,
        },
      });

      expect(fastPathDecision.status).toBe('failure');
      expect(fastPathDecision.eligible).toBe(false);
      expect(fastPathDecision.reason).toBe('blocking-findings');

      // Also verify quorumSatisfied with P0 findings evaluates to blocking-findings:
      const p0QuorumDecision = evaluateReviewGate({
        candidate,
        current,
        evidence: {
          ...derivation.evidence,
          quorumSatisfied: true,
        },
      });

      expect(p0QuorumDecision.status).toBe('failure');
      expect(p0QuorumDecision.eligible).toBe(false);
      expect(p0QuorumDecision.reason).toBe('blocking-findings');

      // Without fast-path or quorum, it fails closed to incomplete-review, never SHIP:
      const incompleteDecision = evaluateReviewGate({
        candidate,
        current,
        evidence: derivation.evidence,
      });

      expect(incompleteDecision.status).toBe('failure');
      expect(incompleteDecision.eligible).toBe(false);
      expect(incompleteDecision.reason).toBe('incomplete-review');
    });

    it('rejects adversarial worker attempting to claim SHIP on partial blocker fast-path run', () => {
      // An adversarial or buggy worker attempts to publish SHIP despite only 1 of 3 planned tasks running
      const adversarialCompletion: WorkerReviewCompletion = {
        version: 'WorkerReviewCompletion.v1',
        ...trustedCoordinates,
        result: {
          version: 'WorkerReviewResult.v1',
          completedAt: '2026-10-08T01:00:00.000Z',
          personas: [
            {
              id: 'task-sec',
              decision: 'APPROVE',
              status: 'COMPLETE',
              findings: [],
            },
          ],
          taskPlan: plannedTasks,
          coverageComplete: true, // Falsely claiming complete coverage
          quorumSatisfied: true,  // Falsely claiming quorum satisfied
          verdict: 'SHIP',        // Malicious or buggy SHIP claim
          findingCount: 0,
          blockingFindingCount: 0,
        },
      };

      const trustedContract: TrustedReviewCoverageContract = {
        expectedCoordinates: trustedCoordinates,
        expectedPersonaIds: ['task-sec', 'task-db', 'task-perf'],
        changedFiles,
        coverageComplete: true,
        quorumSatisfied: true,
        reviewEngine: 'composed',
        composedChangedPaths: ['src/auth/session.ts', 'src/db/query.ts'],
        composedMaxTasks: 8,
      };

      const derivation = deriveCanonicalWorkerReviewEvidence(adversarialCompletion, trustedContract);

      // Must fail closed because canonical arbitration identifies missing expected lanes (1 of 3)
      // and calculates canonical verdict BLOCK, which contradicts the worker's claimed SHIP!
      expect(derivation.valid).toBe(false);
      if (!derivation.valid) {
        expect(derivation.message).toMatch(/worker verdict SHIP disagrees with canonical verdict BLOCK/);
      }
    });

    it('rejects adversarial worker with unknown persona lanes not in planned tasks', () => {
      const spoofedLaneCompletion: WorkerReviewCompletion = {
        version: 'WorkerReviewCompletion.v1',
        ...trustedCoordinates,
        result: {
          version: 'WorkerReviewResult.v1',
          completedAt: '2026-10-08T01:00:00.000Z',
          personas: [
            {
              id: 'task-sec',
              decision: 'FINDINGS',
              status: 'COMPLETE',
              findings: [{ severity: 'P0', path: 'src/auth/session.ts', line: 1, title: 'Bug', body: 'Bug' }],
            },
            {
              id: 'unauthorized-external-lane',
              decision: 'APPROVE',
              status: 'COMPLETE',
              findings: [],
            },
          ],
          taskPlan: plannedTasks,
          coverageComplete: false,
          quorumSatisfied: true,
          verdict: 'BLOCK',
          findingCount: 1,
          blockingFindingCount: 1,
        },
      };

      const trustedContract: TrustedReviewCoverageContract = {
        expectedCoordinates: trustedCoordinates,
        expectedPersonaIds: ['task-sec', 'task-db', 'task-perf'],
        changedFiles,
        coverageComplete: true,
        quorumSatisfied: true,
        reviewEngine: 'composed',
        composedChangedPaths: ['src/auth/session.ts', 'src/db/query.ts'],
        composedMaxTasks: 8,
      };

      const derivation = deriveCanonicalWorkerReviewEvidence(spoofedLaneCompletion, trustedContract);

      expect(derivation.valid).toBe(false);
      if (!derivation.valid) {
        expect(derivation.message).toMatch(/unknown persona lane: unauthorized-external-lane/);
      }
    });
  });
});
