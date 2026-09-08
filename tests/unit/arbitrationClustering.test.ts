import { describe, it, expect } from 'vitest';
const { computeArbitration } = require('../../src/review/reviewCore.js');

const changedFiles = [{ path: 'lib/a.ex', patch: '@@ -1,3 +1,6 @@\n a\n+b\n+c\n+d\n+e\n f' }];
const same = (title: string, line = 3) => ({ severity: 'P1', path: 'lib/a.ex', line, title, body: 'ETS cooldown table is owned by the request process and dies with it, disabling the cooldown.' });

describe('cluster-aware arbitration (RED before patch)', () => {
  it('three personas paraphrasing one P1 is one P1, not a BLOCK', () => {
    const personas = [
      { findings: [same('ETS cooldown table owned by request process is destroyed on exit')] },
      { findings: [same('Cooldown ETS table dies with the creating request process', 4)] },
      { findings: [same('ETS table ownership: cooldown table destroyed when request process exits', 5)] },
    ];
    const a = computeArbitration(personas, 3, { changedFiles });
    expect(a.metrics.p1Count).toBe(1);
    expect(a.verdict).toBe('FIX_FIRST');
    expect(a.findings).toHaveLength(1);
  });
  it('a P1 whose title is a DRY/style claim gates as P2', () => {
    const personas = [{ findings: [{ severity: 'P1', path: 'lib/a.ex', line: 3, title: 'Cross-domain reach-in and DRY violation: alerts layer re-implements the attachment pipeline', body: 'Two copies will drift.' }] }];
    const a = computeArbitration(personas, 1, { changedFiles });
    expect(a.metrics.p1Count).toBe(0);
    expect(a.verdict).toBe('SHIP');
    expect(a.findings[0].severity).toBe('P2');
  });
  // Cluster severity is max-across-reporters, and that decides merge gating: one
  // lane naming the real defect must keep the cluster blocking even when the
  // others filed it lower, and calibration must not be able to demote a cluster
  // that any reporter still holds at P1.
  it('a cluster takes the highest severity any reporter kept', () => {
    const personas = [
      { findings: [{ ...same('Cooldown ETS table dies with the request process'), severity: 'P2' }] },
      { findings: [{ ...same('ETS cooldown table owned by request process is destroyed on exit', 4), severity: 'P1' }] },
      { findings: [{ ...same('ETS table ownership: cooldown destroyed when request exits', 5), severity: 'P2' }] },
    ];
    const a = computeArbitration(personas, 3, { changedFiles });
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0].severity).toBe('P1');
    expect(a.metrics.p1Count).toBe(1);
    expect(a.metrics.p2Count).toBe(0);
    expect(a.verdict).toBe('FIX_FIRST');
  });

  it('demotes only the advisory claim, never its distinct real neighbour', () => {
    // The advisory-title pass runs per finding, before clustering. These two are
    // genuinely different claims, so they must NOT merge -- and the demotion must
    // land only on the DRY one, leaving the real defect blocking.
    const personas = [
      { findings: [{ ...same('Cross-domain reach-in and DRY violation in the cooldown path'), severity: 'P1' }] },
      { findings: [{ ...same('Cooldown silently disabled: ETS owner dies with the request', 4), severity: 'P1' }] },
    ];
    const a = computeArbitration(personas, 2, { changedFiles });
    expect(a.findings).toHaveLength(2);
    expect(a.metrics.p1Count).toBe(1);
    expect(a.metrics.p2Count).toBe(1);
    const demoted = a.findings.find((f: any) => f.severity === 'P2');
    expect(demoted.title).toContain('DRY violation');
    expect(a.verdict).toBe('FIX_FIRST');
  });

  it('a cluster every reporter filed as an advisory claim gates as P2', () => {
    const personas = [
      { findings: [{ ...same('DRY violation: duplicated cooldown helper'), severity: 'P1' }] },
      { findings: [{ ...same('Code duplication in the cooldown helper', 4), severity: 'P1' }] },
    ];
    const a = computeArbitration(personas, 2, { changedFiles });
    expect(a.metrics.p1Count).toBe(0);
    expect(a.findings[0].severity).toBe('P2');
    expect(a.verdict).toBe('SHIP');
  });

  it('never downgrades a P0 and never merges across files', () => {
    const personas = [
      { findings: [{ severity: 'P0', path: 'lib/a.ex', line: 3, title: 'Naming: SQL injection via interpolated org id', body: 'x' }] },
      { findings: [{ severity: 'P0', path: 'lib/a.ex', line: 3, title: 'Naming: SQL injection via interpolated org id', body: 'x' }] },
    ];
    const a = computeArbitration(personas, 2, { changedFiles });
    expect(a.metrics.p0Count).toBe(1);
    expect(a.verdict).toBe('BLOCK');
  });
});
