import { describe, expect, it } from 'vitest';
import { changedLineNumbers, sanitizeFinding, validateReviewFindings } from '../../src/review/reviewCore';

describe('review core diff parsing', () => {
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

  it('retains deletion-only file findings for body fallback publication', () => {
    const finding = sanitizeFinding({
      severity: 'P1',
      path: 'src/removed.ts',
      line: 10,
      title: 'Removed behavior needs migration',
      body: 'The deleted behavior still has a caller.',
    }, [{ path: 'src/removed.ts', patch: '@@ -10,1 +10,0 @@\n-legacy();' }]);
    expect(finding).toMatchObject({ path: 'src/removed.ts', line: 10 });
  });

  it('rejects malformed model fields instead of coercing them into a finding', () => {
    const result = validateReviewFindings([{
      severity: 'CRITICAL',
      path: 'src/review.ts',
      line: '10',
      title: '',
      body: '',
    }]);

    expect(result.valid).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.index).toBe(0);
    expect(result.error).toMatch(/severity/);
  });

  it.each([
    ['non-array payload', { findings: 'nope' }, /findings must be an array/],
    ['non-object item', [null], /finding must be an object/],
    ['absolute path', [{ severity: 'P1', path: '/src/review.ts', line: 1, title: 't', body: 'b' }], /relative/],
    ['parent path', [{ severity: 'P1', path: '../review.ts', line: 1, title: 't', body: 'b' }], /relative/],
    ['string line', [{ severity: 'P1', path: 'src/review.ts', line: '1', title: 't', body: 'b' }], /line must be an integer/],
    ['zero line', [{ severity: 'P1', path: 'src/review.ts', line: 0, title: 't', body: 'b' }], /line must be an integer/],
    ['empty title', [{ severity: 'P1', path: 'src/review.ts', line: 1, title: ' ', body: 'b' }], /title must be/],
    ['empty body', [{ severity: 'P1', path: 'src/review.ts', line: 1, title: 't', body: ' ' }], /body must be/],
    ['invalid suggestion', [{ severity: 'P1', path: 'src/review.ts', line: 1, title: 't', body: 'b', suggestion: 5 }], /suggestion must be/],
  ])('rejects %s without coercion', (_label, payload, expected) => {
    const result = validateReviewFindings(payload);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(expected);
  });

  it('accepts the canonical finding shape without changing valid values', () => {
    const result = validateReviewFindings([{
      severity: 'P1',
      path: './src/review.ts',
      line: 10,
      title: ' Real issue ',
      body: ' Explain the failure. ',
      suggestion: null,
      confidence: 0.9,
    }]);

    expect(result).toEqual({
      valid: true,
      findings: [{
        severity: 'P1',
        path: 'src/review.ts',
        line: 10,
        title: 'Real issue',
        body: 'Explain the failure.',
        confidence: 0.9,
      }],
    });
  });

  it('rejects findings that cannot be anchored to the changed-file hunk', () => {
    const result = validateReviewFindings([{
      severity: 'P1',
      path: 'src/review.ts',
      line: 99,
      title: 'Real issue',
      body: 'Explain the failure.',
    }], [{
      path: 'src/review.ts',
      patch: '@@ -1,1 +10,1 @@\n+const changed = true;',
    }]);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/added line/);
  });

  it('rejects a finding path that is not present in the supplied changed files', () => {
    const result = validateReviewFindings([{
      severity: 'P1',
      path: 'src/other.ts',
      line: 1,
      title: 'Ghost issue',
      body: 'This file was not changed.',
    }], [{ path: 'src/review.ts', patch: '@@ -1,1 +1,1 @@\n+changed;' }]);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/changed file/);
  });
});
