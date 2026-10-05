import { describe, expect, it } from 'vitest';
import { planFindingPublication } from '../../src/review/findingPublication';
import { changedLineNumbers, computeArbitration, sanitizeFinding, validateReviewFindings } from '../../src/review/reviewCore';
import { REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';

describe('review core diff parsing', () => {
  it('keeps an evidence-backed P1 blocking even with one reporter and low confidence', () => {
    const result = computeArbitration([{
      id: 'security', decision: 'FINDINGS', findings: [{
        severity: 'P1', path: 'src/guard.ts', line: 10, title: 'Private profile leaks to anonymous caller',
        body: 'An unauthenticated request returns private account fields.', confidence: 1,
        blockerEvidence: {
          trigger: 'An unauthenticated request reaches this handler without a valid session.',
          impact: 'The caller receives private profile fields belonging to another account.',
          violatedContract: 'Profile data is returned only to the signed in account owner.',
        },
      }],
    }], 1, {
      changedFiles: [{ path: 'src/guard.ts', patch: '@@ -1 +10 @@\n+return profile;' }],
      coverageComplete: true,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(result.findings[0]).toMatchObject({ severity: 'P1', confidence: 1 });
    expect(result.metrics.p1Count).toBe(1);
  });

  it('moves a P1 claim without trigger, impact and contract evidence to advisory P2 with provenance', () => {
    const result = computeArbitration([{
      id: 'security', decision: 'FINDINGS', findings: [{
        severity: 'P1', path: 'src/guard.ts', line: 10, title: 'Potentially unsafe behavior',
        body: 'This may cause a problem for callers.',
        blockerEvidence: { trigger: 'Unknown', impact: '', violatedContract: 'Unstated' },
      }],
    }], 1, {
      changedFiles: [{ path: 'src/guard.ts', patch: '@@ -1 +10 @@\n+return profile;' }],
      coverageComplete: true,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });
    expect(result.findings[0]).toMatchObject({
      severity: 'P2', severityAdjusted: { from: 'P1', reason: expect.stringContaining('blocker evidence') },
    });
    expect(result.metrics.p1Count).toBe(0);
    expect(result.metrics.p2Count).toBe(1);
  });

  it('keeps the verified P1 finding and its proof together when a prior P2 claim clusters first', () => {
    const blockerEvidence = {
      trigger: 'A request without a valid session reaches the profile lookup.',
      impact: 'The handler returns another account holder private profile data.',
      violatedContract: 'Profile data is readable only by its authenticated owner.',
    };
    const lower = { severity: 'P2' as const, path: 'src/guard.ts', line: 10,
      title: 'Profile lookup lacks a session guard', body: 'Requests without a session reach the profile lookup.',
      severityAdjusted: { from: 'P1' as const, reason: 'legacy advisory adjustment' } };
    const verified = { ...lower, severity: 'P1' as const, line: 11,
      body: 'An unauthenticated request reaches the profile lookup and returns private account data.', blockerEvidence };
    const result = computeArbitration([
      { id: 'security', decision: 'FINDINGS', findings: [lower] },
      { id: 'architecture', decision: 'FINDINGS', findings: [verified] },
    ], 2, {
      changedFiles: [{ path: 'src/guard.ts', patch: '@@ -1,0 +10,2 @@\n+guard();\n+return profile;' }],
      coverageComplete: true,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: 'P1', path: verified.path, line: verified.line, title: verified.title,
      body: verified.body, blockerEvidence,
    });
    expect(result.findings[0]).not.toHaveProperty('severityAdjusted');
    expect(result.metrics).toMatchObject({ p1Count: 1, p2Count: 0 });
  });

  it('does not transfer verified blocker proof to a nearby distinct P2 claim', () => {
    const blockerEvidence = {
      trigger: 'An anonymous request reaches the profile lookup.',
      impact: 'The response contains another account holder private data.',
      violatedContract: 'Profile data is readable only by its authenticated owner.',
    };
    const lower = { severity: 'P2' as const, path: 'src/guard.ts', line: 10,
      title: 'Profile cache returns stale account data', body: 'The cache is not invalidated after a profile update.' };
    const verified = { severity: 'P1' as const, path: 'src/guard.ts', line: 11,
      title: 'Profile lookup lacks a session guard', body: 'An anonymous request can read another account holder profile.', blockerEvidence };
    const result = computeArbitration([
      { id: 'security', decision: 'FINDINGS', findings: [lower] },
      { id: 'architecture', decision: 'FINDINGS', findings: [verified] },
    ], 2, {
      changedFiles: [{ path: 'src/guard.ts', patch: '@@ -1,0 +10,2 @@\n+cache();\n+return profile;' }],
      coverageComplete: true,
      severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
    });

    expect(result.findings).toHaveLength(2);
    expect(result.findings.find((finding) => finding.title === lower.title)).toMatchObject({ severity: 'P2' });
    expect(result.findings.find((finding) => finding.title === lower.title)).not.toHaveProperty('blockerEvidence');
    expect(result.findings.find((finding) => finding.title === verified.title)).toMatchObject({ severity: 'P1', blockerEvidence });
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

  it('recognizes gitlink entries via submoduleCandidate flag', () => {
    const finding = sanitizeFinding(
      {
        severity: 'P1',
        path: 'vendor/candidate',
        line: 1,
        title: 'Candidate gitlink changed',
        body: 'Review candidate gitlink target.',
      },
      [{
        path: 'vendor/candidate',
        submoduleCandidate: true,
        patch: '@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n',
      }],
    );
    expect(finding).toMatchObject({ path: 'vendor/candidate', line: 1, severity: 'P1' });
  });

  it('recognizes gitlink entries via patch header mode 160000 without mode property', () => {
    const finding = sanitizeFinding(
      {
        severity: 'P1',
        path: 'vendor/inferred-header',
        line: 1,
        title: 'Inferred header gitlink',
        body: 'Review inferred target.',
      },
      [{
        path: 'vendor/inferred-header',
        patch: 'index 1111111..2222222 160000\n--- a/vendor/inferred-header\n+++ b/vendor/inferred-header\n',
      }],
    );
    expect(finding).toMatchObject({ path: 'vendor/inferred-header', line: 1, severity: 'P1' });
  });

  it('recognizes gitlink entries via Subproject commit SHA line in patch without mode property', () => {
    const finding = sanitizeFinding(
      {
        severity: 'P1',
        path: 'vendor/inferred-commit',
        line: 1,
        title: 'Inferred commit gitlink',
        body: 'Review commit target.',
      },
      [{
        path: 'vendor/inferred-commit',
        patch: '@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n',
      }],
    );
    expect(finding).toMatchObject({ path: 'vendor/inferred-commit', line: 1, severity: 'P1' });
  });

  it('does NOT treat ordinary code files containing token 160000 or commit prose as gitlinks', () => {
    // Normal files must enforce line anchor matching and must not bypass hunk line checks
    const ordinary = sanitizeFinding(
      {
        severity: 'P1',
        path: 'src/constants.ts',
        line: 99, // Line 99 does not match patch hunk (line 10)
        title: 'Constant out of bounds',
        body: 'Check bounds.',
      },
      [{
        path: 'src/constants.ts',
        patch: '@@ -1,1 +10,1 @@\n+const PORT = 160000;\n',
      }],
    );
    expect(ordinary).toBeNull();

    const prose = sanitizeFinding(
      {
        severity: 'P1',
        path: 'docs/submodules.md',
        line: 99,
        title: 'Documentation nit',
        body: 'Fix wording.',
      },
      [{
        path: 'docs/submodules.md',
        patch: '@@ -1,1 +10,1 @@\n+Subproject commit pointers are stored in the index\n',
      }],
    );
    expect(prose).toBeNull();
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


describe('review core replacement metadata', () => {
  const base = { severity: 'P1', path: 'src/review.ts', line: 10, title: 'Issue', body: 'Explanation.' };
  const files = [{ path: base.path, patch: '@@ -8,3 +8,3 @@\n context\n+old();\n+broken();' }];
  const boundaries = {
    validation: (raw: unknown) => {
      const result = validateReviewFindings([raw], files);
      expect(result.valid).toBe(true);
      return result.findings[0];
    },
    sanitization: (raw: unknown) => sanitizeFinding(raw, files),
    'sanitization without diff': (raw: unknown) => sanitizeFinding(raw),
  };
  for (const [name, normalize] of Object.entries(boundaries)) {
    describe(name, () => {
      it.each(['  fixed();\n  done();\n', '', ' ', 'x'.repeat(10_000)])('preserves exact replacement bytes', (replacementCode) => {
        expect(normalize({ ...base, replacementCode, startLine: 9 })).toMatchObject({
          ...base, replacementCode, startLine: 9,
        });
      });
      it.each([undefined, null])('allows absent or null startLine as a single-line replacement', (startLine) => {
        const result = normalize({ ...base, replacementCode: 'fixed();', startLine });
        expect(result).toMatchObject({ ...base, replacementCode: 'fixed();' });
        expect(result).not.toHaveProperty('startLine');
      });
      it.each([0, -1, 11, 9.5, '9', Number.NaN, Number.POSITIVE_INFINITY])('drops unsafe patch metadata for invalid startLine %s', (startLine) => {
        const result = normalize({ ...base, replacementCode: 'fixed();', startLine });
        expect(result).toMatchObject(base);
        expect(result).not.toHaveProperty('replacementCode');
        expect(result).not.toHaveProperty('startLine');
      });
      it.each([42, {}, null, 'x'.repeat(10_001)])('drops invalid or oversized replacement without discarding finding', (replacementCode) => {
        const result = normalize({ ...base, replacementCode });
        expect(result).toMatchObject(base);
        expect(result).not.toHaveProperty('replacementCode');
      });
      it.each(['LEFT', 'left', 'right', 'INVALID', null, 0])('does not turn explicit side %s into a RIGHT replacement', (side) => {
        const result = normalize({ ...base, side, replacementCode: 'fixed();', startLine: 10 });
        expect(result).toMatchObject(base);
        expect(result).not.toHaveProperty('replacementCode');
        expect(result).not.toHaveProperty('startLine');
        if (!result) throw new Error('Expected retained finding');
        const plan = planFindingPublication([result], [{ path: base.path, patch: '@@ -10,1 +10,1 @@\n-old();\n+broken();' }]);
        if (side === 'LEFT' || name !== 'sanitization without diff') expect(plan.lineComments).toHaveLength(1);
        expect(plan.lineComments.every((comment) => !comment.body.includes('```suggestion'))).toBe(true);
      });
      it('retains an explicit RIGHT replacement', () => {
        const result = normalize({ ...base, side: 'RIGHT', replacementCode: 'fixed();' });
        expect(result).toMatchObject({ replacementCode: 'fixed();' });
      });
      it('preserves valid prose finding ranges without replacement code', () => {
        expect(normalize({ ...base, startLine: 9 })).toMatchObject({ ...base, startLine: 9 });
      });
    });
  }
});
