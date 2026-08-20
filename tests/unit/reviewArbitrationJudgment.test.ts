import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeArbitration } from '../../src/review/reviewCore';

/**
 * Executes the judgment corpus at tests/fixtures/bounded-review-engine/arbitration-judgment-cases.json
 * against the real arbiter (computeArbitration), unlike tests/unit/boundedReviewEvaluation.test.ts's
 * evaluation-matrix.json corpus, which only checks that a fixed list of ID/expected-string pairs is
 * present in a JSON file and never calls src/review/reviewCore.js at all. This corpus is deliberately
 * weighted toward judgment (severity weighing, scope containment, coverage quorum) rather than
 * infra/failure-handling, which the existing 12-case matrix already covers.
 *
 * Every `cases[]` entry is a real product-policy decision, not just a behavior snapshot: each one
 * states and justifies the verdict the arbiter is intended to produce. `knownGapCases[]` holds cases
 * where today's actual behavior diverges from the intended policy on purpose (see the `it.fails`
 * block below) -- they are read separately so a normal case can never silently regress into a
 * "known gap" by a typo.
 */
const fixturePath = path.resolve(__dirname, '../fixtures/bounded-review-engine/arbitration-judgment-cases.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

type JudgmentCase = {
  id: string;
  intendedVerdict: string;
  expectedPersonas: number;
  personaResults: unknown[];
  changedFiles?: unknown[];
  expectedPersonaIds?: string[];
  coveragePolicy?: Record<string, unknown>;
};

type KnownGapCase = JudgmentCase & { actualVerdictToday: string };

function runCase(testCase: JudgmentCase) {
  const options: Record<string, unknown> = {};
  if (testCase.changedFiles) options.changedFiles = testCase.changedFiles;
  if (testCase.expectedPersonaIds) options.expectedPersonaIds = testCase.expectedPersonaIds;
  if (testCase.coveragePolicy) options.coveragePolicy = testCase.coveragePolicy;
  return computeArbitration(testCase.personaResults, testCase.expectedPersonas, options);
}

describe('arbitration judgment corpus', () => {
  it('has schemaVersion arbitration-judgment-v1 and at least the seven cases this review added', () => {
    expect(fixture.schemaVersion).toBe('arbitration-judgment-v1');
    expect(Array.isArray(fixture.cases)).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(7);
    expect(Array.isArray(fixture.knownGapCases)).toBe(true);
  });

  for (const testCase of fixture.cases as JudgmentCase[]) {
    it(`${testCase.id} -> ${testCase.intendedVerdict}`, () => {
      const result = runCase(testCase);
      expect(result.verdict, JSON.stringify({ id: testCase.id, rationale: result.rationale })).toBe(testCase.intendedVerdict);
    });
  }

  it('quorum boundary case pair: the label differs but the verdict and mergeEligible do not', () => {
    const atQuorum = runCase(
      (fixture.cases as JudgmentCase[]).find((c) => c.id === 'quorum-boundary-exactly-at-two-thirds')!,
    );
    const belowQuorum = runCase(
      (fixture.cases as JudgmentCase[]).find((c) => c.id === 'quorum-boundary-one-below-two-thirds')!,
    );
    expect(atQuorum.status).toBe('PARTIAL_REVIEW');
    expect(atQuorum.coverageQuorumSatisfied).toBe(true);
    expect(belowQuorum.status).toBe('INCOMPLETE_REVIEW');
    expect(belowQuorum.coverageQuorumSatisfied).toBe(false);
    expect(atQuorum.verdict).toBe(belowQuorum.verdict);
    expect(atQuorum.mergeEligible).toBe(belowQuorum.mergeEligible);
  });

  it('out-of-scope P0 finding is dropped before arbitration, not merely outvoted', () => {
    const testCase = (fixture.cases as JudgmentCase[]).find((c) => c.id === 'out-of-scope-finding-does-not-block')!;
    const result = runCase(testCase);
    expect(result.metrics.p0Count).toBe(0);
    expect(result.metrics.p1Count).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].path).toBe('src/touched.ts');
  });

  describe('known gaps (product-policy decisions pending operator sign-off)', () => {
    for (const gapCase of fixture.knownGapCases as KnownGapCase[]) {
      // `it.fails` inverts pass/fail: this block is expected to throw today, because the assertion
      // below encodes the INTENDED verdict, not the current one. That keeps this file from ever
      // asserting broken behavior as correct. The day computeArbitration is fixed to deduplicate
      // cross-persona claims before counting severities, this block will start passing -- which
      // `it.fails` reports as a FAILURE, forcing whoever fixes it to notice this file and either
      // promote the case out of knownGapCases or update its `actualVerdictToday`.
      it.fails(`${gapCase.id} SHOULD be ${gapCase.intendedVerdict} (currently ${gapCase.actualVerdictToday})`, () => {
        const result = runCase(gapCase);
        expect(result.verdict).toBe(gapCase.intendedVerdict);
      });

      // A companion, currently-passing assertion that pins exactly what "currently diverges" means,
      // so a change to the actual (buggy) count is visible even before anyone fixes the gap for real.
      it(`${gapCase.id} -- pins today's actual (unintended) behavior at ${gapCase.actualVerdictToday}`, () => {
        const result = runCase(gapCase);
        expect(result.verdict).toBe(gapCase.actualVerdictToday);
        expect(result.metrics.p1Count).toBe(3); // three personas, zero cross-persona dedup today
      });
    }
  });
});
