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

  it('does not BLOCK the panel when one provider lane fails and the others completed', () => {
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
    expect(action.verdict).toBe('SHIP');
    expect(action.status).toBe('SHIP');
    expect(action.quorumSatisfied).toBe(true);
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
});
