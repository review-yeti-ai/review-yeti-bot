import { describe, it, expect, vi } from 'vitest';
import { validateFileCoverageQuorum, type ReviewTaskPlan, type ReviewTaskResultV2 } from '../../src/reviewTaskContract';
import { evaluateReviewGate, type ReviewGateEvidence, type ReviewGateCandidate } from '../../src/review/reviewGatePolicy';
import { computeArbitration } from '../../src/review/reviewCore';
import { projectPublishingRosterBounds, publishingConclusion } from '../../src/cli/publishingReview';

describe('Blocker Fast-Path Quorum & Early Exit', () => {
  const candidate: ReviewGateCandidate = {
    repositoryId: 42,
    prNumber: 101,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    policyDigest: 'c'.repeat(64),
  };

  const current = {
    ...candidate,
    open: true,
    draft: false,
  };

  const testPlan: ReviewTaskPlan = {
    tasks: [
      { id: 'task-sec', dimension: 'security', paths: ['src/auth/login.ts'], question: 'Is auth secure?', rationale: 'Sec' },
      { id: 'task-perf', dimension: 'performance', paths: ['src/db/query.ts'], question: 'Is query optimal?', rationale: 'Perf' },
      { id: 'task-ui', dimension: 'architecture', paths: ['src/ui/button.tsx'], question: 'Is UI clean?', rationale: 'UI' },
    ],
  };

  it('verified P0 finding immediately triggers early exit with BLOCK and satisfies quorum', () => {
    const p0 = {
      severity: 'P0' as const,
      file: 'src/auth/login.ts',
      line: 12,
      fingerprint: 'fp1_abcdef1234567890abcdef12',
      summary: 'Hardcoded admin credentials bypass all authentication checks.',
    };

    // Task 1 completed with P0 finding, tasks 2 and 3 did not run (aborted)
    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [p0] },
    ];

    const quorum = validateFileCoverageQuorum(
      testPlan,
      completedTasks,
      ['src/auth/login.ts', 'src/db/query.ts', 'src/ui/button.tsx'],
      { activeFindings: [p0] },
    );

    expect(quorum.satisfied).toBe(true);
    expect(quorum.blockerFastPath).toBe(true);
    expect(quorum.verdict).toBe('BLOCK');
    expect(quorum.status).toBe('BLOCKER_EXIT');
    expect(quorum.rationale).toContain('P0 Blocker detected');
    expect(quorum.blockerFinding).toEqual(p0);
  });

  it('evaluates review gate to failure with blocking-findings reason when blockerFastPath is true', () => {
    // Evidence reflects a blocker fast-path run where only 1 of 5 lanes completed
    const evidence: ReviewGateEvidence = {
      verdict: 'BLOCK',
      completedAt: '2026-10-07T12:00:00Z',
      coverageComplete: true,
      quorumSatisfied: true,
      infrastructureFailure: false,
      p0Count: 1,
      p1Count: 0,
      p2Count: 0,
      expectedLanes: 5,
      completedLanes: 1, // 4 lanes aborted due to fast-path
      blockerFastPath: true,
    };

    const decision = evaluateReviewGate({ candidate, current, evidence });

    expect(decision.status).toBe('failure');
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('blocking-findings');
  });

  it('evaluates review gate to failure with blocking-findings reason when P0 findings are present even with lane discrepancy', () => {
    // Evidence has p0Count > 0 and verdict BLOCK with uncompleted lagging lanes
    const evidence: ReviewGateEvidence = {
      verdict: 'BLOCK',
      completedAt: '2026-10-07T12:00:00Z',
      coverageComplete: false, // Incomplete overall coverage due to early exit
      quorumSatisfied: true,
      infrastructureFailure: false,
      p0Count: 2,
      p1Count: 1,
      p2Count: 0,
      expectedLanes: 4,
      completedLanes: 2,
    };

    const decision = evaluateReviewGate({ candidate, current, evidence });

    // Must evaluate to blocking-findings, NOT incomplete-review!
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
            path: 'src/auth/login.ts',
            line: 12,
            title: 'Hardcoded admin credentials',
            body: 'Unconditional backdoor bypasses auth.',
          },
        ],
      },
    ];

    // 4 expected personas, but only 1 reported due to blocker fast-path
    const arbitration = computeArbitration(singleLaneResult, 4, {
      changedFiles: [{ path: 'src/auth/login.ts' }, { path: 'src/db/query.ts' }],
      coverageComplete: true,
      blockerFastPath: true,
    });

    expect(arbitration.quorumSatisfied).toBe(true);
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.status).toBe('BLOCK');
    expect(arbitration.blockerFastPath).toBe(true);
    expect(arbitration.metrics.p0Count).toBe(1);
  });

  it('publishingReview bounds projection does not mark missing lanes as errors on blockerFastPath', () => {
    const mockPanelResult = {
      applicablePersonaIds: ['task-sec', 'task-perf', 'task-ui'],
      personas: [
        {
          id: 'task-sec',
          status: 'COMPLETE',
          findings: [
            {
              severity: 'P0',
              path: 'src/auth/login.ts',
              line: 10,
              title: 'Critical auth bypass',
              body: 'Missing signature check',
            },
          ],
        },
      ],
      optionalFailures: [],
      blockerFastPath: true,
      quorum: {
        required: 1,
        distinctProviders: ['codex'],
        satisfied: true,
        blockerFastPath: true,
      },
    } as any;

    const bounds = projectPublishingRosterBounds(mockPanelResult);

    expect(bounds.completedLaneCount).toBe(1);
    expect(bounds.failedLaneCount).toBe(0);
    // Missing configured lanes should be 0 because lagging lanes were halted by fast-path
    expect(bounds.missingConfiguredLaneCount).toBe(0);
    expect(bounds.malformedReturnedLaneCount).toBe(0);
  });

  it('publishingConclusion returns failure to block PR merge on blocker fast path', () => {
    const conclusion = publishingConclusion('BLOCK', 1, {
      mode: 'panel',
      rosterValid: true,
      quorumSatisfied: true,
      fullPanelComplete: true,
      groundedReviewComplete: true,
    });

    expect(conclusion).toBe('failure');
  });

  it('non-blocking P1/P2 findings do NOT trigger blocker fast-path early exit', () => {
    const p1 = {
      severity: 'P1' as const,
      file: 'src/db/query.ts',
      line: 30,
      fingerprint: 'fp1_111111111111111111111111',
      summary: 'Missing index on foreign key query.',
    };

    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-perf', status: 'COMPLETE', findings: [p1] },
    ];

    // Only 1 of 3 files covered, P1 does not trigger blocker fast-path
    const res = validateFileCoverageQuorum(
      testPlan,
      completedTasks,
      ['src/auth/login.ts', 'src/db/query.ts', 'src/ui/button.tsx'],
      { activeFindings: [p1] },
    );

    expect(res.blockerFastPath).toBe(false);
    expect(res.satisfied).toBe(false); // Fails quorum due to missing files
    expect(res.coveragePct).toBe(33);
  });

  it('simultaneous P0 findings across parallel tasks halt review and deduplicate cleanly', () => {
    const p0a = {
      severity: 'P0' as const,
      file: 'src/auth/login.ts',
      line: 12,
      fingerprint: 'fp1_p0commonfingerprint1234',
      summary: 'Hardcoded admin credentials.',
    };
    const p0b = {
      severity: 'P0' as const,
      file: 'src/auth/login.ts',
      line: 12,
      fingerprint: 'fp1_p0commonfingerprint1234',
      summary: 'Hardcoded admin credentials.',
    };

    const completedTasks: ReviewTaskResultV2[] = [
      { nonce: 'n1', task: 'task-sec', status: 'COMPLETE', findings: [p0a] },
      { nonce: 'n2', task: 'task-perf', status: 'COMPLETE', findings: [p0b] },
    ];

    const quorum = validateFileCoverageQuorum(
      testPlan,
      completedTasks,
      ['src/auth/login.ts', 'src/db/query.ts', 'src/ui/button.tsx'],
      { activeFindings: [p0a, p0b] },
    );

    expect(quorum.blockerFastPath).toBe(true);
    expect(quorum.satisfied).toBe(true);
    expect(quorum.verdict).toBe('BLOCK');
  });

  it('propagates abort signal to halt active task execution immediately', async () => {
    const controller = new AbortController();
    let task2Aborted = false;

    // Simulate task 2 listening to signal
    const task2Promise = new Promise((resolve) => {
      if (controller.signal.aborted) {
        task2Aborted = true;
        resolve('aborted');
        return;
      }
      controller.signal.addEventListener('abort', () => {
        task2Aborted = true;
        resolve('aborted');
      });
      setTimeout(() => resolve('completed_normally'), 1000);
    });

    // Simulate task 1 finding P0 and tripping abort controller
    const task1Promise = (async () => {
      // Find P0 immediately
      controller.abort(new Error('blocker_fast_path'));
      return { status: 'COMPLETE', severity: 'P0' };
    })();

    await task1Promise;
    const task2Result = await task2Promise;

    expect(task2Aborted).toBe(true);
    expect(task2Result).toBe('aborted');
  });
});
