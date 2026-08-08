import { describe, expect, it } from 'vitest';
import { changedLineNumbers, computeArbitration, sanitizeFinding } from '../../src/review/reviewCore';

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
