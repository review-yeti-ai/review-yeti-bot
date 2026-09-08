import { describe, expect, it } from 'vitest';
import {
  findingDedupeKey,
  formatFindingCommentBody,
  mergeNearDuplicateClaims,
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

  it('validates multiple ranges across files sharing the same patch text', () => {
    const plan = planFindingPublication([
      { severity: 'P1', path: 'src/app.ts', line: 21, startLine: 20, replacementCode: 'guard();', title: 'Account guard', body: 'Check account ownership.' },
      { severity: 'P2', path: 'src/app.ts', line: 22, startLine: 21, replacementCode: 'name();', title: 'Name value', body: 'Clarify the variable name.' },
      { severity: 'P1', path: 'src/other.ts', line: 51, title: 'Handle error', body: 'Propagate the failure.' },
    ], [{ path: 'src/app.ts', patch: textPatch }, { path: 'src/other.ts', patch: textPatch }]);
    expect(plan.lineComments).toHaveLength(3);
    expect(plan.lineComments.filter(comment => comment.startLine !== undefined)).toHaveLength(2);
    expect(plan.fileComments).toEqual([]);
  });

  it('uses the first changed-file entry consistently when duplicate paths carry different patches', () => {
    const plan = planFindingPublication([
      { severity: 'P1', path: 'src/app.ts', line: 21, startLine: 20, replacementCode: 'guard();', title: 'Account guard', body: 'Check account ownership.' },
    ], [
      { path: 'src/app.ts', patch: textPatch },
      { path: 'src/app.ts', patch: '@@ -1 +1 @@\n-old();\n+new();' },
    ]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0]).toMatchObject({ line: 21, startLine: 20 });
    expect(plan.lineComments[0].finding.replacementCode).toBe('guard();');
    expect(plan.fileComments).toEqual([]);
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

  it('publishes P2 findings inline with their full body and safe replacement', () => {
    const plan = planFindingPublication([{
      severity: 'P2', path: 'src/app.ts', line: 21, title: 'Prefer a clearer name',
      body: 'The name obscures which account owns this value.', persona: 'consistency',
      replacementCode: 'const accountId = account.id;',
    }], [{ path: 'src/app.ts', patch: textPatch }]);

    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0]).toMatchObject({ path: 'src/app.ts', line: 21 });
    expect(plan.lineComments[0].body).toContain('The name obscures');
    expect(plan.lineComments[0].body).toContain('```suggestion');
    expect(plan.advisories).toEqual([]);
  });

  it('publishes P2 findings on patchless files as file conversations', () => {
    const plan = planFindingPublication([{
      severity: 'P2', path: 'assets/logo.png', line: 1, title: 'Logo has low contrast',
      body: 'Increase contrast against the navigation background.',
    }], [{ path: 'assets/logo.png' }]);
    expect(plan.fileComments).toHaveLength(1);
    expect(plan.fileComments[0].body).toContain('Increase contrast');
    expect(plan.advisories).toEqual([]);
  });

  it('uses file-level conversations for patchless, binary, and gitlink changed files', () => {
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

  it('falls back to a file conversation for context lines while rejecting invalid paths and missing lines', () => {
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
    expect(plan.fileComments).toHaveLength(2);
    expect(plan.fileComments.map(comment => comment.path)).toEqual(['src/app.ts', 'src/malformed.ts']);
    expect(plan.fileComments[0].line).toBeUndefined();
    expect(plan.fileComments[0].body).toContain('Reported location: line 20');
    expect(plan.rejected).toHaveLength(2);
    expect(plan.rejected.map((item) => item.reason)).toEqual(expect.arrayContaining([
      'finding path is not present in the changed files',
      'finding line must be a positive integer',
    ]));
    expect(plan.rejected.find((item) => item.title === 'No line')?.line).toBeUndefined();
  });

  it.each([20, 500])('publishes an unanchored finding at reported line %i as file prose without a replacement', (line) => {
    const plan = planFindingPublication([{
      severity: 'P2', path: 'src/app.ts', line, title: 'Clarify account ownership',
      body: 'This value belongs to the current account.', startLine: line - 1,
      replacementCode: 'const accountId = account.id;', suggestion: 'Use an account-specific name.',
    }], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.fileComments).toHaveLength(1);
    expect(plan.fileComments[0].line).toBeUndefined();
    expect(plan.fileComments[0].finding.replacementCode).toBeUndefined();
    expect(plan.fileComments[0].finding.startLine).toBeUndefined();
    expect(plan.fileComments[0].body).toContain('Use an account-specific name.');
    expect(plan.fileComments[0].body).not.toContain('```suggestion');
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

  const patchFinding = {
    severity: 'P1' as const, path: 'src/app.ts', line: 22,
    title: 'Unsafe fallback', body: 'The fallback bypasses validation.',
    suggestion: 'Validate the fallback.',
  };

  it.each(['    validate();\n    run();\n', '', '  ', 'const fence = "```";'])('preserves exact replacement text %j', (replacementCode) => {
    const plan = planFindingPublication([{ ...patchFinding, replacementCode }], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments[0].finding.replacementCode).toBe(replacementCode);
    expect(plan.lineComments[0].body).toContain(`suggestion\n${replacementCode}\n`);
  });

  it('anchors a replacement range including context within the same new-file hunk', () => {
    const plan = planFindingPublication([{ ...patchFinding, startLine: 20, replacementCode: '  guarded();' }], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments[0]).toMatchObject({ startLine: 20, line: 22, side: 'RIGHT' });
    expect(plan.lineComments[0].body).toContain('```suggestion\n  guarded();\n```');
  });

  it.each([
    { startLine: 19 }, { startLine: 23 }, { startLine: 0 }, { startLine: 20.5 },
    { startLine: '20' }, { startLine: 21, line: 51 },
  ])('keeps prose but suppresses unsafe replacement range %j', (range) => {
    const plan = planFindingPublication([{ ...patchFinding, replacementCode: 'guarded();', ...range } as any], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].startLine).toBeUndefined();
    expect(plan.lineComments[0].finding.replacementCode).toBeUndefined();
    expect(plan.lineComments[0].body).not.toContain('```suggestion');
    expect(plan.lineComments[0].body).toContain('Validate the fallback.');
  });

  it('does not offer replacements on deleted lines or file-level comments', () => {
    const left = planFindingPublication([{ ...patchFinding, line: 11, side: 'LEFT', replacementCode: 'guarded();' }], [{ path: 'src/app.ts', patch: textPatch }]);
    const file = planFindingPublication([{ ...patchFinding, replacementCode: 'guarded();' }], [{ path: 'src/app.ts' }]);
    for (const comment of [...left.lineComments, ...file.fileComments]) {
      expect(comment.finding.replacementCode).toBeUndefined();
      expect(comment.body).not.toContain('```suggestion');
      expect(comment.body).toContain('Validate the fallback.');
    }
  });

  it('never borrows a replacement from a nearby merged finding', () => {
    const plan = planFindingPublication([
      { ...patchFinding, line: 21 },
      { ...patchFinding, replacementCode: 'onlyCorrectAtLine22();' },
    ], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].line).toBe(21);
    expect(plan.lineComments[0].body).not.toContain('```suggestion');
  });

  it('drops conflicting patches from duplicate reports, including later matching reports', () => {
    const plan = planFindingPublication([
      { ...patchFinding, replacementCode: 'first();' },
      { ...patchFinding, replacementCode: 'second();' },
      { ...patchFinding, replacementCode: 'first();' },
    ], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].body).not.toContain('```suggestion');
  });

  it('preserves conflict suppression when merging differently titled duplicate groups', () => {
    const plan = planFindingPublication([
      { ...patchFinding, title: 'Tenant query bypasses validation', replacementCode: 'first();' },
      { ...patchFinding, title: 'Tenant query skips validation', replacementCode: 'second();' },
      { ...patchFinding, title: 'Tenant query skips validation', replacementCode: 'third();' },
    ], [{ path: 'src/app.ts', patch: textPatch }]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0].body).not.toContain('```suggestion');
  });
});


describe('merging a file-anchored claim with a line-anchored one', () => {
  const claim = {
    severity: 'P1' as const,
    path: 'src/inventory.ts',
    title: 'Cancel bypasses the inventory-access entitlement check',
    body: 'The cancel endpoint checks only stock Update permission and never calls HasInventoryAccessAsync, so a tenant whose module is disabled can still mutate inventory-audit records.',
    personas: ['Security'],
  };

  // `mergeClaimInto` promotes a file-level conversation to a line anchor when the same claim also
  // arrived anchored to a line. `planFindingPublication` cannot currently produce that pair on its
  // own -- it holds one file object per path, so every finding on a path takes the same
  // file-vs-line branch -- so the exported merge step is where the rule is reachable and tested.
  it('keeps the line anchor, because it is the more useful place for the conversation', () => {
    const [merged] = mergeNearDuplicateClaims([
      { subjectType: 'file', finding: { ...claim, line: 1, side: 'RIGHT' } },
      { subjectType: 'line', finding: { ...claim, line: 248, side: 'RIGHT', body: `${claim.body} Every other endpoint calls it.` } },
    ] as any);

    expect(merged.subjectType).toBe('line');
    expect(merged.finding.line).toBe(248);
    expect(merged.finding.side).toBe('RIGHT');
  });

  it('does not downgrade a line anchor when the file-level report arrives second', () => {
    const [merged] = mergeNearDuplicateClaims([
      { subjectType: 'line', finding: { ...claim, line: 248, side: 'RIGHT' } },
      { subjectType: 'file', finding: { ...claim, line: 1, side: 'RIGHT', body: `${claim.body} Every other endpoint calls it.` } },
    ] as any);

    expect(merged.subjectType).toBe('line');
    expect(merged.finding.line).toBe(248);
  });

  it('credits both reviewers and keeps the richer body across the upgrade', () => {
    const [merged] = mergeNearDuplicateClaims([
      { subjectType: 'file', finding: { ...claim, line: 1, side: 'RIGHT', personas: ['Architecture'] } },
      { subjectType: 'line', finding: { ...claim, line: 248, side: 'RIGHT', body: `${claim.body} Every other endpoint calls it.`, personas: ['Security'] } },
    ] as any);

    expect(merged.finding.personas).toEqual(['Architecture', 'Security']);
    expect(merged.finding.body).toContain('Every other endpoint calls it.');
  });
});


describe('anchoring against blank context lines', () => {
  // GitHub prefixes context with a space, but blank context often arrives with the prefix stripped.
  // If such a line did not advance both images, every anchor after it would be off by one and
  // findings below a blank line would be rejected as "not an exact changed line".
  it('advances both images across unprefixed blank context', () => {
    const patch = [
      '@@ -10,4 +10,4 @@',
      ' const before = 1;',
      '',
      '-const removed = 2;',
      '+const added = 2;',
    ].join('\n');

    const anchors = parsePatchAnchors(patch);

    expect(anchors.hasHunks).toBe(true);
    expect([...anchors.right]).toEqual([12]);
    expect([...anchors.left]).toEqual([12]);

    // Same hunk without the blank line: the anchors sit one line earlier, which is precisely what
    // would be reported for the patch above if the blank line stopped advancing the images.
    const withoutBlank = parsePatchAnchors(['@@ -10,4 +10,4 @@', ' const before = 1;', '-const removed = 2;', '+const added = 2;'].join('\n'));
    expect([...withoutBlank.right]).toEqual([11]);
  });

  it('does not count a trailing newline as a context line', () => {
    const withTrailing = parsePatchAnchors('@@ -1,2 +1,2 @@\n+added\n');
    const withoutTrailing = parsePatchAnchors('@@ -1,2 +1,2 @@\n+added');

    expect([...withTrailing.right]).toEqual([...withoutTrailing.right]);
    expect([...withTrailing.right]).toEqual([1]);
  });

  it('publishes a finding anchored below unprefixed blank context', () => {
    const patch = ['@@ -1,4 +1,4 @@', ' first', '', '+third'].join('\n');
    const plan = planFindingPublication([{
      displayName: 'Security',
      findings: [{
        severity: 'P1' as const,
        path: 'src/handler.ts',
        line: 3,
        title: 'Tenant identifier reaches the query builder unvalidated',
        body: 'The handler interpolates the caller-supplied tenant id into the predicate, widening the row set beyond the caller.',
      }],
    }], [{ path: 'src/handler.ts', patch }]);

    expect(plan.rejected).toEqual([]);
    expect(plan.lineComments).toHaveLength(1);
    expect(plan.lineComments[0]?.line).toBe(3);
  });
});
