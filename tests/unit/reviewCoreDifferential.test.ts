import { describe, expect, it } from 'vitest';
import { computeAppVerdict } from '../../src/review/reviewAdapters';
import {
  advisoryRequiredByDefault,
  blockingFindingCount,
  blockingFindingSeverities,
  computeArbitration,
  ReviewLane,
} from '../../src/review/reviewCore';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');

const changedFiles = [
  {
    path: 'src/review.ts',
    patch: '@@ -1,1 +10,3 @@\n+const changed = true;\n+export { changed };\n',
  },
];

const lanes = [
  { id: 'security', required: true, decision: 'APPROVE', findings: [] },
  { id: 'correctness', required: false, decision: 'APPROVE', findings: [] },
];

function actionVerdict(results: unknown[], expected = 2, options: Record<string, unknown> = {}) {
  return pipeline.computeArbitrationQuorum(results, expected, { changedFiles, ...options });
}

describe('canonical review contract differential', () => {
  it('produces byte-stable identical Action and App verdicts for a clean review', () => {
    const action = actionVerdict(lanes);
    const app = computeAppVerdict({ lanes, expectedLanes: 2, changedFiles });

    expect(action).toEqual(app);
    expect(action.verdict).toBe('SHIP');
    expect(action.status).toBe('SHIP');
  });

  it('requires P2 at both publishing boundaries while keeping low-level arbitration opt-in', () => {
    const p2Only: ReviewLane[] = [
      { id: 'security', required: true, decision: 'FINDINGS', findings: [
        { severity: 'P2', path: 'src/review.ts', line: 10, title: 'Required advisory', body: 'Address this before merge.' },
      ] },
      { id: 'correctness', required: false, decision: 'APPROVE', findings: [] },
    ];
    const configured = process.env.REVIEW_YETI_REQUIRE_ADVISORY;
    delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
    try {
      const app = computeAppVerdict({
        lanes: p2Only,
        expectedLanes: 2,
        changedFiles,
        candidateVerdict: 'SHIP',
      });
      const action = actionVerdict(p2Only);
      const pure = computeArbitration(p2Only, 2, { changedFiles });

      expect(advisoryRequiredByDefault()).toBe(true);
      expect(blockingFindingSeverities()).toEqual(['P0', 'P1', 'P2']);
      expect(blockingFindingCount({ p0Count: 0, p1Count: 0, p2Count: 1 })).toBe(1);
      expect(app.verdict).toBe('FIX_FIRST');
      expect(app.metrics.p2Count).toBe(1);
      expect(action.verdict).toBe('FIX_FIRST');
      expect(pure.verdict).toBe('SHIP');
    } finally {
      if (configured === undefined) delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
      else process.env.REVIEW_YETI_REQUIRE_ADVISORY = configured;
    }
  });

  it('honors the configured P0/P1-only rollback through both publishing boundaries', () => {
    const p2Only: ReviewLane[] = [
      { id: 'security', required: true, decision: 'FINDINGS', findings: [
        { severity: 'P2', path: 'src/review.ts', line: 10, title: 'Advisory', body: 'A P2-only finding.' },
      ] },
      { id: 'correctness', required: false, decision: 'APPROVE', findings: [] },
    ];
    const configured = process.env.REVIEW_YETI_REQUIRE_ADVISORY;
    process.env.REVIEW_YETI_REQUIRE_ADVISORY = 'false';
    try {
      expect(advisoryRequiredByDefault()).toBe(false);
      expect(blockingFindingSeverities()).toEqual(['P0', 'P1']);
      expect(blockingFindingCount({ p0Count: 0, p1Count: 0, p2Count: 1 })).toBe(0);
      expect(computeAppVerdict({ lanes: p2Only, expectedLanes: 2, changedFiles }).verdict).toBe('SHIP');
      expect(actionVerdict(p2Only).verdict).toBe('SHIP');
      // The pure kernel remains opt-in independently of the publishing-boundary default.
      expect(computeArbitration(p2Only, 2, { changedFiles }).verdict).toBe('SHIP');
    } finally {
      if (configured === undefined) delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
      else process.env.REVIEW_YETI_REQUIRE_ADVISORY = configured;
    }
  });

  it('keeps pure arbitration byte-identical across runtime policy changes for each explicit advisory option', () => {
    const p2Only: ReviewLane[] = [
      { id: 'security', required: true, decision: 'FINDINGS', findings: [
        { severity: 'P2', path: 'src/review.ts', line: 10, title: 'Advisory', body: 'A P2-only finding.' },
      ] },
      { id: 'correctness', required: false, decision: 'APPROVE', findings: [] },
    ];
    const configured = process.env.REVIEW_YETI_REQUIRE_ADVISORY;
    try {
      for (const requireAdvisory of [undefined, false, true]) {
        const options = { changedFiles, ...(requireAdvisory === undefined ? {} : { requireAdvisory }) };
        const receipts = [undefined, 'false', 'true'].map((policy) => {
          if (policy === undefined) delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
          else process.env.REVIEW_YETI_REQUIRE_ADVISORY = policy;
          const result = computeArbitration(p2Only, 2, options);
          expect(result.verdict).toBe(requireAdvisory === true ? 'FIX_FIRST' : 'SHIP');
          return JSON.stringify(result);
        });
        expect(new Set(receipts).size).toBe(1);
      }
    } finally {
      if (configured === undefined) delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
      else process.env.REVIEW_YETI_REQUIRE_ADVISORY = configured;
    }
  });

  it('keeps findings and verdicts identical while removing out-of-diff paths', () => {
    const results: ReviewLane[] = [
      {
        id: 'security',
        required: true,
        decision: 'FINDINGS',
        findings: [
          { severity: 'P1', path: 'src/review.ts', line: 10, title: 'Real issue', body: 'Fix it.' },
          { severity: 'P0', path: 'src/not-changed.ts', line: 1, title: 'Invalid issue', body: 'Ignore it.' },
        ],
      },
      { id: 'correctness', required: false, decision: 'APPROVE', findings: [] },
    ];

    const action = actionVerdict(results);
    const app = computeAppVerdict({ lanes: results, expectedLanes: 2, changedFiles });

    expect(action).toEqual(app);
    expect(action.metrics).toMatchObject({ p0Count: 0, p1Count: 1, totalFindings: 1 });
    expect(action.verdict).toBe('FIX_FIRST');
  });

  it('fails closed identically when a lane errors or coverage is incomplete', () => {
    const results = [
      { id: 'security', required: true, decision: 'ERROR', error: 'provider timeout', findings: [] },
    ];

    const action = actionVerdict(results, 2);
    const app = computeAppVerdict({ lanes: results, expectedLanes: 2, changedFiles });

    expect(action).toEqual(app);
    expect(action.verdict).toBe('BLOCK');
    expect(action.status).toBe('INCOMPLETE_REVIEW');
    expect(action.quorumSatisfied).toBe(false);
  });

  it('fails closed when one provider lane fails even if the others completed', () => {
    const results = [
      { id: 'security', required: true, decision: 'APPROVE', findings: [] },
      { id: 'architecture', required: true, decision: 'ERROR', error: 'HTTP 404: No endpoints available', findings: [] },
      { id: 'testing', required: true, decision: 'APPROVE', findings: [] },
      { id: 'performance', required: true, decision: 'APPROVE', findings: [] },
      { id: 'dependencies', required: true, decision: 'APPROVE', findings: [] },
    ];

    const action = actionVerdict(results, 5);
    const app = computeAppVerdict({ lanes: results, expectedLanes: 5, changedFiles });

    expect(action).toEqual(app);
    expect(action.verdict).toBe('BLOCK');
    expect(action.status).toBe('INCOMPLETE_REVIEW');
    expect(action.quorumSatisfied).toBe(false);
    expect(action.completedPersonas).toBe(4);
  });

  it('does not permit a requested SHIP when coverage is explicitly incomplete', () => {
    const action = actionVerdict(lanes, 2, { coverageComplete: false });
    const app = computeAppVerdict({ lanes, expectedLanes: 2, changedFiles, coverageComplete: false });

    expect(action).toEqual(app);
    expect(action.verdict).toBe('BLOCK');
    expect(action.status).toBe('INCOMPLETE_REVIEW');
  });

  it('blocks identically when no reviewer personas are enabled', () => {
    const action = actionVerdict([], 0);
    const app = computeAppVerdict({ lanes: [], expectedLanes: 0, changedFiles });

    expect(action).toEqual(app);
    expect(action.verdict).toBe('BLOCK');
    expect(action.status).toBe('INCOMPLETE_REVIEW');
    expect(action.quorumSatisfied).toBe(false);
  });

  // REL-491: calltelemetry/ct-release#1360 (runs 33469453744, 33469858871) — all 3 personas
  // APPROVE, zero findings, zero failed lanes, yet the verdict was BLOCK with a rationale that
  // asserted BOTH "Quorum satisfied for release." and "must remain blocked" in the same sentence,
  // because a coverage-only signal (unrelated to persona execution) forced `incomplete=true` and
  // the incomplete branch appended its blocking clause onto the clean-panel sentence verbatim
  // instead of replacing it.
  describe('REL-491: coverage-only incompleteness never contradicts a clean panel', () => {
    it('never asserts both "quorum satisfied" and "must remain blocked" when coverage alone forces BLOCK', () => {
      const action = actionVerdict(lanes, 2, { coverageComplete: false });
      const app = computeAppVerdict({ lanes, expectedLanes: 2, changedFiles, coverageComplete: false });

      expect(action).toEqual(app);
      expect(action.verdict).toBe('BLOCK');
      expect(action.status).toBe('INCOMPLETE_REVIEW');

      // The defect: concatenating the clean-panel sentence with the block clause produced text
      // that simultaneously claims the quorum is satisfied and that merge approval is blocked.
      const assertsQuorumSatisfied = /quorum satisfied/i.test(action.rationale);
      const assertsBlocked = /must remain blocked|merge approval remains blocked/i.test(action.rationale);
      expect(assertsQuorumSatisfied && assertsBlocked).toBe(false);
    });

    it('names the concrete missing artifact instead of a generic boilerplate restatement', () => {
      const app = computeAppVerdict({
        lanes,
        expectedLanes: 2,
        changedFiles,
        coverageComplete: false,
        coverageGaps: [{ path: 'k8s', reason: 'submodule change is not bound to a valid pinned commit transition' }],
      });

      expect(app.verdict).toBe('BLOCK');
      expect(app.rationale).toContain('k8s');
      expect(app.rationale).toContain('submodule change is not bound to a valid pinned commit transition');
      expect(/quorum satisfied/i.test(app.rationale)).toBe(false);
    });

    it('still logs a named gap even when the caller does not supply coverageGaps, rather than a bare boolean', () => {
      const app = computeAppVerdict({ lanes, expectedLanes: 2, changedFiles, coverageComplete: false });

      // No caller-supplied gap detail: the rationale must still not silently restate the
      // clean-panel sentence, and must say evidence/coverage is the reason, not findings.
      expect(app.rationale).toMatch(/evidence\/coverage gap/i);
      expect(/quorum satisfied/i.test(app.rationale)).toBe(false);
    });

    it('never renders "0 persona lane(s) failed" when no lane actually failed', () => {
      const action = actionVerdict(lanes, 2, { coverageComplete: false });
      const app = computeAppVerdict({ lanes, expectedLanes: 2, changedFiles, coverageComplete: false });

      expect(action.rationale).not.toMatch(/0 persona lane\(s\) failed/i);
      expect(app.rationale).not.toMatch(/0 persona lane\(s\) failed/i);
    });
  });
});
