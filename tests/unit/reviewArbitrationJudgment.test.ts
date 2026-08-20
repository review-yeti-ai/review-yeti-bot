import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { computeArbitration } from '../../src/review/reviewCore';

/**
 * Executes the judgment corpus at tests/fixtures/bounded-review-engine/arbitration-judgment-cases.json
 * against the real arbiter (computeArbitration), unlike tests/unit/boundedReviewEvaluation.test.ts's
 * evaluation-matrix.json corpus, which only checks that a fixed list of ID/expected-string pairs is
 * present in a JSON file and never calls src/review/reviewCore.js at all. This corpus is deliberately
 * weighted toward judgment (severity weighing, scope containment, coverage quorum, cross-persona
 * dedup) rather than infra/failure-handling, which the existing 12-case matrix already covers.
 *
 * Every `cases[]` entry is a real product-policy decision, not just a behavior snapshot: each one
 * states and justifies the verdict the arbiter is intended to produce. `knownGapCases[]` is kept as
 * an (empty) array so a case can be demoted back into it -- run via vitest's `it.fails`, see the
 * describe block below -- the day something diverges from intended policy again; it previously held
 * `duplicates-across-personas-do-not-triple-count`, promoted into `cases` now that
 * src/review/reviewCore.js's clusterFindingsForVerdict makes that the actual (not just intended)
 * behavior.
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

/** A minimal, valid lane: APPROVE, no findings. */
function cleanLane() {
  return { decision: 'APPROVE', findings: [] as unknown[] };
}

/** A lane with one P2 finding at its own path, so it never accidentally clusters with a sibling. */
function distinctP2Lane(i: number) {
  return {
    decision: 'FINDINGS',
    findings: [{
      severity: 'P2',
      path: `src/nit-${i}.ts`,
      line: 1,
      title: `Nit ${i}: prefer a named constant`,
      body: `Magic value on line 1 of file ${i} should be a named constant for readability.`,
    }],
  };
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
    it('has no open known gaps right now (duplicates-across-personas-do-not-triple-count was promoted into cases[])', () => {
      expect(fixture.knownGapCases).toEqual([]);
    });

    // Empty today: kept so a future gap can be added here and run the same way (it.fails against
    // the intended verdict, plus a companion pin of the actual one), without inventing the pattern
    // again.
    for (const gapCase of fixture.knownGapCases as KnownGapCase[]) {
      it.fails(`${gapCase.id} SHOULD be ${gapCase.intendedVerdict} (currently ${gapCase.actualVerdictToday})`, () => {
        const result = runCase(gapCase);
        expect(result.verdict).toBe(gapCase.intendedVerdict);
      });
      it(`${gapCase.id} -- pins today's actual (unintended) behavior at ${gapCase.actualVerdictToday}`, () => {
        const result = runCase(gapCase);
        expect(result.verdict).toBe(gapCase.actualVerdictToday);
      });
    }
  });

  describe('cross-persona dedup (Decision 2: cluster before counting, corroboration has no verdict effect)', () => {
    it('collapses three differently-worded reports of one real defect to one P1, flipping BLOCK to FIX_FIRST', () => {
      const testCase = (fixture.cases as JudgmentCase[]).find((c) => c.id === 'duplicates-across-personas-do-not-triple-count')!;
      const result = runCase(testCase);
      // The raw list is untouched -- three individual findings, one per persona -- only the counts
      // that feed the verdict are deduplicated.
      expect(result.findings).toHaveLength(3);
      expect(result.metrics.rawFindingCount).toBe(3);
      // But exactly one distinct claim, corroborated by all three, is what the verdict is based on.
      expect(result.metrics.p1Count).toBe(1);
      expect(result.metrics.totalFindings).toBe(1);
      expect(result.findingClusters).toHaveLength(1);
      expect(result.findingClusters[0]).toMatchObject({ severity: 'P1', corroboration: 3 });
      expect(result.verdict).toBe('FIX_FIRST');
      // Rationale integrity: the human-facing text names the deduplicated count, not the raw one --
      // it must say "1 P1", never "3 P1(s)".
      expect(result.rationale).toContain('1 P1 finding(s)');
      expect(result.rationale).not.toMatch(/\b3 P1/);
      expect(result.rationale).toMatch(/independently reported 3 times/);
    });

    it('escalates a cluster to the most severe rating any member carried on its own (max-of-members, not volume)', () => {
      // Two personas describe the same idempotency defect in chargeCustomer; one calls it a P2 nit,
      // the other a P1. The merged claim must carry the P1 -- "most serious wins" on cluster
      // membership -- exactly as findingPublication.js's mergeClaimInto already does for the
      // comments it posts.
      const result = computeArbitration([
        { decision: 'FINDINGS', findings: [{
          severity: 'P2',
          path: 'src/pay/charge.ts',
          line: 40,
          title: 'chargeCustomer does not check idempotencyKey before charging',
          body: 'chargeCustomer runs the charge without checking idempotencyKey first, which could double-charge on a client retry.',
        }] },
        { decision: 'FINDINGS', findings: [{
          severity: 'P1',
          path: 'src/pay/charge.ts',
          line: 40,
          title: 'Missing idempotencyKey check in chargeCustomer allows double charge',
          body: 'chargeCustomer never checks idempotencyKey before charging, so a client retry can double-charge the customer.',
        }] },
        { decision: 'APPROVE', findings: [] },
      ], 3);
      expect(result.findingClusters).toHaveLength(1);
      expect(result.findingClusters[0]).toMatchObject({ severity: 'P1', corroboration: 2 });
      expect(result.metrics).toMatchObject({ p1Count: 1, p2Count: 0, rawFindingCount: 2 });
      expect(result.verdict).toBe('FIX_FIRST');
    });

    it('never escalates severity from corroboration alone: three P2-only agreeing reports stay P2', () => {
      // The inverse risk of the test above: three personas all independently rate the SAME claim
      // P2. Corroboration (3 lanes agreeing) is correlated evidence, not three independent
      // confirmations, and must never manufacture a P1 that no individual persona actually raised.
      const claim = (title: string, body: string) => ({
        severity: 'P2', path: 'src/pay/charge.ts', line: 40, title, body,
      });
      const result = computeArbitration([
        { decision: 'FINDINGS', findings: [claim(
          'chargeCustomer does not check idempotencyKey before charging',
          'chargeCustomer runs the charge without checking idempotencyKey first, which could double-charge on a client retry.',
        )] },
        { decision: 'FINDINGS', findings: [claim(
          'Missing idempotencyKey check in chargeCustomer',
          'chargeCustomer never checks idempotencyKey before charging, which could double-charge on a client retry.',
        )] },
        { decision: 'FINDINGS', findings: [claim(
          'chargeCustomer should verify idempotencyKey first',
          'Before charging, chargeCustomer should verify idempotencyKey; right now it charges without checking idempotencyKey and could double-charge on retry.',
        )] },
      ], 3);
      expect(result.findingClusters).toHaveLength(1);
      expect(result.findingClusters[0]).toMatchObject({ severity: 'P2', corroboration: 3 });
      expect(result.metrics).toMatchObject({ p1Count: 0, p2Count: 1, rawFindingCount: 3 });
      // A single distinct P2, however corroborated, is nowhere near this 3-persona panel's fixP2
      // floor of 5 -- SHIP, not FIX_FIRST or BLOCK.
      expect(result.verdict).toBe('SHIP');
    });

    it('pins the sign-off transition: P2 dedup can flip FIX_FIRST to SHIP at the fixP2 boundary', () => {
      // Five personas independently flag the identical unused-import nit. Before dedup, 5 raw P2
      // findings would meet this panel's fixP2 floor of max(5, panelSize) = 5 and produce FIX_FIRST.
      // This is the ONE place the arbiter's actual merge outcome changes: mergeEligible requires
      // SHIP, so this transition (and only this one -- P0/P1 always BLOCK/FIX_FIRST the panel
      // regardless of dedup) is what the operator signed off on.
      const wording = [
        ['formatDate imports moment but never uses it', 'formatDate.ts imports moment at the top of the file, but nothing in formatDate.ts calls moment anywhere.'],
        ['Unused moment import in formatDate', 'The moment import in formatDate.ts is unused; formatDate.ts never calls moment after this import.'],
        ['moment is imported in formatDate but not called', 'formatDate.ts brings in moment via this import, but no code in formatDate.ts calls moment.'],
        ['Remove the unused moment import from formatDate', 'This import brings moment into formatDate.ts, yet formatDate.ts never calls moment; the import can be removed.'],
        ['formatDate no longer needs the moment import', 'Since formatDate.ts never calls moment, the moment import at the top of formatDate.ts is unused and can be dropped.'],
      ] as const;
      const personaResults = wording.map(([title, body]) => ({
        decision: 'FINDINGS',
        findings: [{ severity: 'P2', path: 'src/utils/formatDate.ts', line: 4, title, body }],
      }));
      const result = computeArbitration(personaResults, 5);
      expect(result.metrics.rawFindingCount).toBe(5); // what pre-dedup counting saw (== old fixP2 floor)
      expect(result.metrics.p2Count).toBe(1); // what the verdict actually sees post-dedup
      expect(result.findingClusters).toHaveLength(1);
      expect(result.findingClusters[0]).toMatchObject({ severity: 'P2', corroboration: 5 });
      expect(result.verdict).toBe('SHIP');
      expect(result.mergeEligible).toBe(true);
    });

    it('distinct P2 nits across different files never cluster, regardless of similar wording', () => {
      // Sanity check on the other direction: compareClaims requires a path match before it looks at
      // claim text at all, so N genuinely different findings never collapse just because their
      // prose sounds alike.
      const result = computeArbitration(
        Array.from({ length: 6 }, (_, i) => distinctP2Lane(i)),
        6,
      );
      expect(result.findingClusters).toHaveLength(6);
      expect(result.metrics.p2Count).toBe(6);
      expect(result.metrics.rawFindingCount).toBe(6);
      // 6 distinct P2s across a 6-persona panel meets fixP2 = max(5, 6) = 6.
      expect(result.verdict).toBe('FIX_FIRST');
    });

    it('publication is untouched by construction: findingPublication.js clusters personaResults independently, never arbitration.findings', () => {
      // computeArbitration's own `findings` output stays the raw, per-finding list -- dedup only
      // changes `metrics`/`findingClusters`/the verdict. Confirms the contract, not just asserts it:
      // .github/workflows/pipelines/review-pipeline.js calls computeArbitrationQuorum (9524) before
      // planFindingPublication (9618), and planFindingPublication's first argument is the pipeline's
      // own `personaResults` variable, not `arbitration.findings` -- so nothing this file changed
      // could reach publication's dedup pass even indirectly.
      const pipelineSrc = fs.readFileSync(
        path.resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js'),
        'utf8',
      );
      const arbitrationCallIndex = pipelineSrc.indexOf('arbitration = computeArbitrationQuorum(personaResults');
      const publicationCallIndex = pipelineSrc.indexOf('const publicationPlan = planFindingPublication(personaResults');
      expect(arbitrationCallIndex).toBeGreaterThan(-1);
      expect(publicationCallIndex).toBeGreaterThan(-1);
      expect(arbitrationCallIndex).toBeLessThan(publicationCallIndex);
    });
  });
});
