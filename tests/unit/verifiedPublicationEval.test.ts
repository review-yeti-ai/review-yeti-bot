import { describe, expect, it } from 'vitest';

import {
  findingMatchesFixture,
  gradeFindings,
  verifyCandidateRows,
  wilson,
} from '../../scripts/evaluate-verified-publication.mjs';

const fixture = {
  id: 'defect-1',
  category: 'defect',
  title: 'seeded defect',
  expectedPaths: ['tests/app.test.js'],
  mustMatch: [['vacuous', 'always passes'], ['default']],
  files: [{ path: 'tests/app.test.js', patch: '@@ -1,2 +1,2 @@\n-a\n+b' }],
};

const cleanFixture = {
  id: 'clean-1',
  category: 'clean',
  title: 'benign refactor',
  expectedPaths: ['src/app.js'],
  mustMatch: [],
  files: [{ path: 'src/app.js', patch: '@@ -1,2 +1,2 @@\n-a\n+b' }],
};

function matchingFinding() {
  return {
    severity: 'P1',
    path: 'tests/app.test.js',
    line: 2,
    side: 'RIGHT',
    title: 'Vacuous assertion',
    body: 'The test always passes because it compares the default against itself.',
  };
}

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    arm: 'candidate',
    fixtureId: 'defect-1',
    category: 'defect',
    repetition: 1,
    latencyMs: 1000,
    usage: { promptTokens: 100, completionTokens: 50, costUSD: 0.002 },
    errored: false,
    detected: true,
    falsePositive: false,
    anchored: true,
    findings: 1,
    findingsDetail: [matchingFinding()],
    findingTitles: ['tests/app.test.js:2 Vacuous assertion'],
    ...overrides,
  };
}

function verdictClient(verdict: string, extra: Record<string, unknown> = {}) {
  return async () => ({
    verdict: undefined,
    ok: true,
    content: JSON.stringify({ complete: true, verdict, ...extra }),
    usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50, costUSD: 0.0005 },
  });
}

const confirmFields = {
  violated_invariant: 'the assertion compares the default to itself',
  failure_path: 'any regression in the default keeps the test green',
  benign_explanation_check: 'no other assertion covers the value',
};

describe('grading mirror', () => {
  it('matches the harness contract: anchored path AND every concept group', () => {
    expect(findingMatchesFixture(matchingFinding(), fixture)).toBe(true);
    expect(findingMatchesFixture({ ...matchingFinding(), path: 'src/other.js' }, fixture)).toBe(false);
    expect(findingMatchesFixture({ ...matchingFinding(), body: 'always passes but never names the other idea' }, fixture)).toBe(false);
  });

  it('grades clean fixtures on any surviving finding', () => {
    expect(gradeFindings(cleanFixture, [matchingFinding()], false).falsePositive).toBe(true);
    expect(gradeFindings(cleanFixture, [], false).falsePositive).toBe(false);
  });

  it('computes a Wilson interval', () => {
    const interval = wilson(1, 32);
    expect(interval?.[0]).toBeGreaterThanOrEqual(0);
    expect(interval?.[1]).toBeLessThan(0.2);
  });
});

describe('verifyCandidateRows', () => {
  it('keeps a detected row detected when the verifier confirms', async () => {
    const { rows, verifierStats } = await verifyCandidateRows({
      rows: [laneRow()],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('CONFIRM', confirmFields),
    });
    expect(rows[0].arm).toBe('verified');
    expect(rows[0].detected).toBe(true);
    expect(verifierStats.confirmed).toBe(1);
    // Added cost and latency are accounted, not hidden.
    expect(rows[0].usage.promptTokens).toBe(140);
    expect(rows[0].latencyMs).toBeGreaterThanOrEqual(1000);
  });

  it('clears a clean-fixture false positive when the verifier refutes', async () => {
    const row = laneRow({ fixtureId: 'clean-1', category: 'clean', detected: false, falsePositive: true, noise: 1, findingsDetail: [{ ...matchingFinding(), path: 'src/app.js' }] });
    const { rows } = await verifyCandidateRows({
      rows: [row],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('REFUTE', { benign_explanation: 'behavior-preserving refactor' }),
    });
    expect(rows[0].falsePositive).toBe(false);
    expect(rows[0].findings).toBe(0);
    // SNR inputs are recomputed on the confirmed subset, never inherited from the candidate row.
    expect(rows[0].noise).toBe(0);
  });

  it('withholds on abstention: a detected row loses its finding but never gains one', async () => {
    const { rows, verifierStats } = await verifyCandidateRows({
      rows: [laneRow()],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => verdictClient('ABSTAIN'),
    });
    expect(rows[0].detected).toBe(false);
    expect(verifierStats.abstained).toBe(1);
  });

  it('passes errored lane rows through unchanged without calling the verifier', async () => {
    let called = 0;
    const { rows } = await verifyCandidateRows({
      rows: [laneRow({ errored: true, error: 'provider_failure', detected: false, findingsDetail: [matchingFinding()] })],
      matrix: { fixtures: [fixture, cleanFixture] },
      falsifyTurnFactory: () => async () => { called += 1; return { ok: false, error: 'should not run' }; },
    });
    expect(called).toBe(0);
    expect(rows[0].errored).toBe(true);
    expect(rows[0].detected).toBe(false);
  });
});
