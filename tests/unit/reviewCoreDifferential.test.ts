import { describe, expect, it } from 'vitest';
import { computeAppVerdict } from '../../src/review/reviewAdapters';

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

  it('keeps findings and verdicts identical while removing out-of-diff paths', () => {
    const results = [
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
