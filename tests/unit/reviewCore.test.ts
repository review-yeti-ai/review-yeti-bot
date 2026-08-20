import { describe, expect, it } from 'vitest';
import {
  changedLineNumbers, computeArbitration, sanitizeFinding, INFRA_FAILURE_REASONS, isInfraFailure,
} from '../../src/review/reviewCore';

describe('review core diff parsing', () => {
  it('counts carried open findings without changing persona coverage', () => {
    const lanes = Array.from({ length: 5 }, (_, index) => ({
      personaId: `persona-${index}`,
      decision: 'APPROVE',
      findings: [],
    }));
    const result = computeArbitration(lanes, 5, {
      carriedFindings: [{
        severity: 'P1', path: 'src/a.ts', line: 4, title: 'Still open', body: 'The defect is still open.',
      }],
    });

    expect(result.completedPersonas).toBe(5);
    expect(result.metrics.p1Count).toBe(1);
    expect(result.verdict).toBe('FIX_FIRST');
  });

  it('validates carried blockers against the complete change rather than the reviewer slice', () => {
    const result = computeArbitration([{ decision: 'APPROVE', findings: [] }], 1, {
      changedFiles: [{ path: 'src/shown.ts', patch: '@@ -1 +1 @@\n+shown();' }],
      carriedChangedFiles: [{ path: 'src/excluded.ts', patch: '' }],
      carriedFindings: [{
        severity: 'P1', path: 'src/excluded.ts', line: 1, title: 'Still open', body: 'The excluded defect is still open.',
      }],
    });

    expect(result.metrics.p1Count).toBe(1);
    expect(result.verdict).toBe('FIX_FIRST');
  });

  it('blocks a clean panel when coverage is incomplete', () => {
    const arbitration = computeArbitration(
      [{ decision: 'APPROVE', findings: [] }],
      1,
      { coverageComplete: false },
    );

    expect(arbitration).toMatchObject({
      verdict: 'BLOCK',
      status: 'INCOMPLETE_REVIEW',
      coverageComplete: false,
      quorumSatisfied: false,
    });
  });

  it('honors the configured coverage quorum for the status label, never for the verdict or mergeEligible', () => {
    // 5-persona roster, quorum: 'two_thirds' -> requiredCoverageCount(5, 'two_thirds') === 4.
    const roster = ['security', 'testing', 'contract', 'performance', 'architecture'];
    const laneFor = (id: string, i: number) => ({
      id, provider: `provider-${i % 2}`, model: 'review-model', decision: 'APPROVE', findings: [],
    });
    const policy = { mandatory_personas: [], provider_diversity_min: 1 };

    // Exactly at the configured quorum: 4/5 trustworthy, zero findings.
    const atQuorum = computeArbitration(
      roster.slice(0, 4).map(laneFor),
      5,
      { expectedPersonaIds: roster, coveragePolicy: policy },
    );
    expect(atQuorum.coverageQuorumSatisfied).toBe(true); // the configured quorum WAS met
    expect(atQuorum.status).toBe('PARTIAL_REVIEW');
    expect(atQuorum.quorumSatisfied).toBe(false); // but this field means full coverage, not quorum
    expect(atQuorum.verdict).toBe('BLOCK'); // and the verdict is BLOCK regardless of quorum
    expect(atQuorum.mergeEligible).toBe(false);

    // One below the configured quorum: 3/5 trustworthy.
    const belowQuorum = computeArbitration(
      roster.slice(0, 3).map(laneFor),
      5,
      { expectedPersonaIds: roster, coveragePolicy: policy },
    );
    expect(belowQuorum.coverageQuorumSatisfied).toBe(false);
    expect(belowQuorum.status).toBe('INCOMPLETE_REVIEW');
    expect(belowQuorum.verdict).toBe('BLOCK');
    expect(belowQuorum.mergeEligible).toBe(false);

    // The only observable difference the quorum setting makes is the status label and
    // coverageQuorumSatisfied -- verdict and mergeEligible are identical on both sides of it.
    expect(atQuorum.verdict).toBe(belowQuorum.verdict);
    expect(atQuorum.mergeEligible).toBe(belowQuorum.mergeEligible);
  });

  it('does not advance changed line numbers for no-newline metadata', () => {
    const patch = [
      '@@ -1,2 +10,3 @@',
      '+first changed line',
      '\\ No newline at end of file',
      '+second changed line',
    ].join('\n');

    expect(changedLineNumbers(patch)).toEqual(new Set([10, 11]));
  });

  it('canonicalizes Windows separators when sanitizing findings against changed files', () => {
    const finding = sanitizeFinding(
      {
        severity: 'P1',
        path: 'src\\review.ts',
        line: 10,
        title: 'Real issue',
        body: 'Fix it.',
      },
      [
        {
          path: 'src/review.ts',
          patch: '@@ -1,1 +10,1 @@\n+const changed = true;',
        },
      ],
    );

    expect(finding).toMatchObject({ path: 'src/review.ts', line: 10 });
  });

  it('advances through an empty context line inside a hunk', () => {
    const patch = [
      '@@ -1,3 +10,4 @@',
      '+first changed line',
      '',
      '+second changed line',
    ].join('\n');

    expect(changedLineNumbers(patch)).toEqual(new Set([10, 12]));
  });

  it('keeps a valid gitlink finding when the patch has no line-numbered hunk', () => {
    const finding = sanitizeFinding(
      {
        severity: 'P1',
        path: 'vendor/lib',
        line: 1,
        title: 'Pinned dependency changed',
        body: 'Review the new gitlink target.',
      },
      [{
        path: 'vendor/lib',
        mode: '160000',
        isSubmodule: true,
        patch: '-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }],
    );

    expect(finding).toMatchObject({ path: 'vendor/lib', line: 1, severity: 'P1' });
  });

  it('keeps added lines whose content begins with plus signs', () => {
    const patch = '@@ -1,1 +10,1 @@\n+++count;\n';
    expect(changedLineNumbers(patch)).toEqual(new Set([10]));
  });

  it('parses hunk headers whose function context contains a plus sign', () => {
    expect(changedLineNumbers('@@ -10,1 +20,1 @@ function c++()\n+changed;')).toEqual(new Set([20]));
  });

  it('retains exact LEFT-side deletion findings', () => {
    const finding = sanitizeFinding({
      severity: 'P1',
      path: 'src/removed.ts',
      line: 10,
      side: 'LEFT',
      title: 'Removed behavior needs migration',
      body: 'The deleted behavior still has a caller.',
    }, [{ path: 'src/removed.ts', patch: '@@ -10,1 +10,0 @@\n-legacy();' }]);
    expect(finding).toMatchObject({ path: 'src/removed.ts', line: 10, side: 'LEFT' });
  });

  it('defaults legacy findings to RIGHT and never coerces a missing or invalid line to line 1', () => {
    const files = [{ path: 'src/app.ts', patch: '@@ -1,1 +10,1 @@\n+changed();' }];

    expect(sanitizeFinding({
      severity: 'P1', path: 'src/app.ts', line: 10, title: 'Issue', body: 'Body',
    }, files)).toMatchObject({ line: 10, side: 'RIGHT' });
    expect(sanitizeFinding({
      severity: 'P1', path: 'src/app.ts', title: 'Issue', body: 'Body',
    }, files)).toBeNull();
    expect(sanitizeFinding({
      severity: 'P1', path: 'src/app.ts', line: 0, title: 'Issue', body: 'Body',
    }, files)).toBeNull();
    expect(sanitizeFinding({
      severity: 'P1', path: 'src/app.ts', title: 'Issue', body: 'Body',
    })).toBeNull();
  });

  it('infers LEFT for an omitted side only when the line is an exact deletion anchor', () => {
    expect(sanitizeFinding({
      severity: 'P1', path: 'src/removed.ts', line: 10, title: 'Issue', body: 'Body',
    }, [{ path: 'src/removed.ts', patch: '@@ -10,1 +10,0 @@\n-legacy();' }])).toMatchObject({
      line: 10,
      side: 'LEFT',
    });
    expect(sanitizeFinding({
      severity: 'P1', path: 'src/removed.ts', line: 11, title: 'Issue', body: 'Body',
    }, [{ path: 'src/removed.ts', patch: '@@ -10,1 +10,0 @@\n-legacy();' }])).toBeNull();
  });
});

// API-2902: N-1 quorum tolerance + the INCOMPLETE_INFRA status split. Evidenced live:
// cisco-cdr #4411/#4413 blocked twice with 4/5 personas approving and 0 P0/P1/P2 findings
// because a single lane errored (schema_contract_violation once, ttft_timeout once) --
// indistinguishable in the old status vocabulary from a real findings-based BLOCK.
describe('infra-vs-verdict status split (API-2902)', () => {
  const okLane = (id: string) => ({
    personaId: id, decision: 'APPROVE', findings: [], provider: 'openrouter', model: 'm',
  });
  const infraFailedLane = (id: string, reason: string) => ({
    personaId: id, decision: 'ERROR', error: reason, failure: { reason },
  });

  it('classifies the reason vocabulary consistently with reviewInvestigation.js', () => {
    expect([...INFRA_FAILURE_REASONS].sort()).toEqual(['schema_contract_violation', 'timeout', 'ttft_timeout']);
    expect(isInfraFailure(infraFailedLane('a', 'ttft_timeout'))).toBe(true);
    expect(isInfraFailure(infraFailedLane('a', 'semantic_invalid_response'))).toBe(false);
    expect(isInfraFailure({ personaId: 'a', decision: 'APPROVE' })).toBe(false);
  });

  it('reports INCOMPLETE_INFRA -- not a generic BLOCK -- when N-1 personas clear with zero blocking findings and the sole failure is infra-classified', () => {
    const lanes = [okLane('security'), okLane('performance'), okLane('testing'), okLane('architecture'), infraFailedLane('style', 'ttft_timeout')];
    const arbitration = computeArbitration(lanes, 5, {
      expectedPersonaIds: ['security', 'performance', 'testing', 'architecture', 'style'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).toBe('INCOMPLETE_INFRA');
    // Still fail-closed: never an auto-pass, same as INCOMPLETE_REVIEW/BLOCK.
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.mergeEligible).toBe(false);
    expect(arbitration.gateDecision).toBe('BLOCKED');
    expect(arbitration.infraFailure).toBe(true);
    expect(arbitration.infraFailedPersonaIds).toEqual(['style']);
    expect(arbitration.rationale).toMatch(/ttft_timeout/);
  });

  it('reports INCOMPLETE_INFRA even when the failed lane is the mandatory persona (the shape of the live cisco-cdr #4411/#4413 incident)', () => {
    // Without the infra classification this would land on `mandatorySatisfied: false` in
    // coveragePolicy.js's evaluateCoverage, forcing plain INCOMPLETE_REVIEW regardless of how
    // many other lanes passed cleanly -- exactly the "single failed lane blocks even with 4/5
    // personas approving and 0 findings" gap reported against API-2900's landing.
    const lanes = [infraFailedLane('security', 'ttft_timeout'), okLane('performance'), okLane('testing'), okLane('architecture'), okLane('style')];
    const arbitration = computeArbitration(lanes, 5, {
      expectedPersonaIds: ['security', 'performance', 'testing', 'architecture', 'style'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).toBe('INCOMPLETE_INFRA');
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.mergeEligible).toBe(false);
    expect(arbitration.infraFailedPersonaIds).toEqual(['security']);
  });

  it('does not report INCOMPLETE_INFRA when a P1 finding is present alongside the infra failure', () => {
    const lanes = [
      {
        personaId: 'security', decision: 'FINDINGS', provider: 'openrouter', model: 'm',
        findings: [{ severity: 'P1', path: 'a.ts', line: 1, title: 't', body: 'b' }],
      },
      okLane('performance'), okLane('testing'), okLane('architecture'),
      infraFailedLane('style', 'timeout'),
    ];
    const arbitration = computeArbitration(lanes, 5, {
      expectedPersonaIds: ['security', 'performance', 'testing', 'architecture', 'style'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).not.toBe('INCOMPLETE_INFRA');
    expect(arbitration.verdict).toBe('BLOCK');
    expect(arbitration.mergeEligible).toBe(false);
  });

  it('does not report INCOMPLETE_INFRA when the failure is not infra-classified (a real semantic/provider defect)', () => {
    // Coverage quorum math alone (4/5 trustworthy, mandatory security present) already lands
    // this on PARTIAL_REVIEW, not a hard INCOMPLETE_REVIEW -- the point under test is narrower:
    // a `semantic_invalid_response` lane failure must never be relabeled INCOMPLETE_INFRA, since
    // that reason means the model actually answered and its output failed the review's own
    // contract, not that the provider/transport broke.
    const lanes = [okLane('security'), okLane('performance'), okLane('testing'), okLane('architecture'), infraFailedLane('style', 'semantic_invalid_response')];
    const arbitration = computeArbitration(lanes, 5, {
      expectedPersonaIds: ['security', 'performance', 'testing', 'architecture', 'style'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).not.toBe('INCOMPLETE_INFRA');
    expect(arbitration.status).toBe('PARTIAL_REVIEW');
    expect(arbitration.infraFailure).toBeUndefined();
  });

  it('does not report INCOMPLETE_INFRA below N-1 quorum (two failed lanes)', () => {
    const lanes = [
      okLane('security'), okLane('performance'), okLane('testing'),
      infraFailedLane('architecture', 'ttft_timeout'), infraFailedLane('style', 'timeout'),
    ];
    const arbitration = computeArbitration(lanes, 5, {
      expectedPersonaIds: ['security', 'performance', 'testing', 'architecture', 'style'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).not.toBe('INCOMPLETE_INFRA');
    expect(arbitration.status).toBe('INCOMPLETE_REVIEW');
  });

  it('still shows PARTIAL_REVIEW mechanics elsewhere: a fully clean panel with no failures never gets INCOMPLETE_INFRA', () => {
    const lanes = [okLane('security'), okLane('performance'), okLane('testing')];
    const arbitration = computeArbitration(lanes, 3, {
      expectedPersonaIds: ['security', 'performance', 'testing'],
      coveragePolicy: { quorum: 'two_thirds', min_personas: 3, mandatory_personas: ['security'], provider_diversity_min: 1 },
    });

    expect(arbitration.status).toBe('SHIP');
    expect(arbitration.infraFailure).toBeUndefined();
  });
});
