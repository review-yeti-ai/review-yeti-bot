import { describe, expect, it } from 'vitest';
import {
  findingDedupeKey,
  formatFindingCommentBody,
  parsePatchAnchors,
  planFindingPublication,
} from '../../src/review/findingPublication';

const textPatch = [
  '@@ -10,4 +20,5 @@ first',
  ' context',
  '-removed();',
  '+added();',
  '+another();',
  ' context',
  '@@ -40,2 +51,2 @@ second',
  '-old();',
  '+newer();',
  ' context',
].join('\n');

describe('shared finding publication planner', () => {
  it('parses exact RIGHT additions and LEFT deletions across multiple hunks', () => {
    const anchors = parsePatchAnchors(textPatch);

    expect(anchors.hasHunks).toBe(true);
    expect(anchors.right).toEqual(new Set([21, 22, 51]));
    expect(anchors.left).toEqual(new Set([11, 40]));
  });

  it('defaults legacy findings to RIGHT and publishes every actionable finding without a cap', () => {
    const patch = `@@ -0,0 +1,12 @@\n${Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`).join('\n')}`;
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: 'P1' as const,
      path: 'src/many.ts',
      line: i + 1,
      title: `Finding ${i + 1}`,
      body: `Body ${i + 1}`,
      persona: 'correctness',
    }));

    const plan = planFindingPublication(findings, [{ path: 'src/many.ts', patch }]);

    expect(plan.lineComments).toHaveLength(12);
    expect(plan.lineComments.every((comment) => comment.side === 'RIGHT')).toBe(true);
    expect(plan.rejected).toEqual([]);
  });

  it('infers LEFT when an omitted side can only refer to an exact deleted line', () => {
    const plan = planFindingPublication([{
      severity: 'P1', path: 'src/removed.ts', line: 10,
      title: 'Removed behavior still has callers', body: 'The deletion breaks the legacy caller.',
    }], [{ path: 'src/removed.ts', patch: '@@ -10,1 +10,0 @@\n-legacy();' }]);

    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0]).toMatchObject({ path: 'src/removed.ts', line: 10, side: 'LEFT' });
    expect(plan.rejected).toEqual([]);
  });

  it('deduplicates across personas, keeps the highest severity and richest content, and merges attribution', () => {
    const plan = planFindingPublication([
      {
        id: 'security',
        displayName: 'Security Specialist',
        findings: [{
          severity: 'P1', path: 'src/app.ts', line: 21, title: ' Unsafe  fallback ',
          body: 'Short body.', suggestion: 'Add a guard.',
        }],
      },
      {
        personaId: 'correctness',
        findings: [{
          severity: 'P0', path: 'src/app.ts', line: 21, side: 'RIGHT', title: 'unsafe fallback',
          body: 'This is the longer and more complete explanation of the unsafe fallback.',
          suggestion: 'Validate the fallback before using it and return a typed failure.',
        }],
      },
    ], [{ path: 'src/app.ts', patch: textPatch }]);

    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].finding).toMatchObject({
      severity: 'P0',
      body: 'This is the longer and more complete explanation of the unsafe fallback.',
      suggestion: 'Validate the fallback before using it and return a typed failure.',
      personas: ['correctness', 'Security Specialist'],
    });
    expect(plan.lineComments[0].body).toContain('**Reported by:** `correctness`, `Security Specialist`');
    expect(findingDedupeKey(plan.lineComments[0].finding)).not.toContain('P0');
  });

  it('keeps P2 findings advisory and title-only at the plan boundary', () => {
    const plan = planFindingPublication([{
      severity: 'P2', path: 'src/app.ts', line: 21, title: 'Prefer a clearer name',
      body: 'A detailed advisory body that must not become a thread.', persona: 'consistency',
    }], [{ path: 'src/app.ts', patch: textPatch }]);

    expect(plan.lineComments).toEqual([]);
    expect(plan.fileComments).toEqual([]);
    expect(plan.advisories).toHaveLength(1);
    expect(plan.advisories[0]).toMatchObject({ path: 'src/app.ts', line: 21, title: 'Prefer a clearer name' });
    expect(Object.prototype.hasOwnProperty.call(plan.advisories[0], 'body')).toBe(false);
  });

  it('uses file-level conversations only for patchless, binary, and gitlink changed files', () => {
    const findings = [
      { severity: 'P1' as const, path: 'assets/logo.png', line: 1, title: 'Binary issue', body: 'Replace it.' },
      { severity: 'P0' as const, path: 'vendor/lib', line: 99, title: 'Gitlink issue', body: 'Pin it.' },
    ];
    const plan = planFindingPublication(findings, [
      { path: 'assets/logo.png' },
      { path: 'vendor/lib', mode: '160000', patch: '@@ -1 +1 @@\n-old\n+new' },
    ]);

    expect(plan.fileComments.map((comment) => comment.path)).toEqual(['vendor/lib', 'assets/logo.png']);
    expect(plan.fileComments.every((comment) => comment.line === undefined && comment.side === undefined)).toBe(true);
    expect(plan.rejected).toEqual([]);
  });

  it('rejects wrong hunk lines, invalid paths, and missing lines without inventing line 1', () => {
    const plan = planFindingPublication([
      { severity: 'P1', path: 'src/app.ts', line: 20, title: 'Context line', body: 'Not changed.' },
      { severity: 'P1', path: 'src/malformed.ts', line: 1, title: 'Malformed', body: 'No hunk.' },
      { severity: 'P1', path: 'src/missing.ts', line: 1, title: 'Missing', body: 'Not changed.' },
      { severity: 'P1', path: 'src/app.ts', title: 'No line', body: 'No anchor.' } as any,
    ], [
      { path: 'src/app.ts', patch: textPatch },
      { path: 'src/malformed.ts', patch: '+not a unified hunk' },
    ]);

    expect(plan.lineComments).toEqual([]);
    expect(plan.fileComments).toHaveLength(1);
    expect(plan.fileComments[0].path).toBe('src/malformed.ts');
    expect(plan.rejected).toHaveLength(3);
    expect(plan.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'finding line is not an exact changed RIGHT line',
      'finding path is not present in the changed files',
      'finding line must be a positive integer',
    ]));
    expect(plan.rejected.find((item) => item.title === 'No line')?.line).toBeUndefined();
  });

  it('treats suggestion as prose and only explicit replacementCode as a suggestion block', () => {
    const prose = formatFindingCommentBody({
      severity: 'P1', title: 'Guard input', body: 'Input is unchecked.',
      suggestion: 'Validate it before use.', personas: ['security'],
    });
    const replacement = formatFindingCommentBody({
      severity: 'P1', title: 'Guard input', body: 'Input is unchecked.',
      replacementCode: 'if (!input) return;', personas: [],
    });

    expect(prose).toContain('**Suggested fix**\n\nValidate it before use.');
    expect(prose).not.toContain('```suggestion');
    expect(replacement).toContain('```suggestion\nif (!input) return;\n```');
  });

  it('orders equivalent plans deterministically regardless of persona input order', () => {
    const findings = [
      { severity: 'P1' as const, path: 'src/app.ts', line: 22, title: 'B', body: 'b', persona: 'b' },
      { severity: 'P0' as const, path: 'src/app.ts', line: 51, title: 'C', body: 'c', persona: 'c' },
      { severity: 'P1' as const, path: 'src/app.ts', line: 21, title: 'A', body: 'a', persona: 'a' },
    ];
    const files = [{ path: 'src/app.ts', patch: textPatch }];

    const forward = planFindingPublication(findings, files);
    const reverse = planFindingPublication([...findings].reverse(), files);

    expect(forward).toEqual(reverse);
    expect(forward.lineComments.map((comment) => comment.finding.title)).toEqual(['C', 'A', 'B']);
  });
});
