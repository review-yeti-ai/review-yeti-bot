import { describe, expect, it } from 'vitest';
import {
  ACTIONABLE_SEVERITIES,
  MAX_FINAL_INLINE_COMMENTS,
  PERSONA_ISSUE_MARKER_PREFIX,
  buildFinalInlineComments,
  dedupeActionableFindings,
  formatFinalReviewBody,
  formatPersonaIssueComment,
  findingDedupeKey,
} from '../../src/github/panelPublication';
import { CommentPublisher, formatInlineCommentBody } from '../../src/github/commentPublisher';
import { buildPanelResponseFormat, validateFindings } from '../../src/panel/panelEngine';

describe('panelPublication', () => {
  const baseFinding = {
    severity: 'P1' as const,
    path: 'src/a.ts',
    line: 10,
    title: 'Live tenant PII committed',
    body: 'Do not commit tenant phone numbers.',
  };

  it('dedupes identical findings across personas and attributes both', () => {
    const result = dedupeActionableFindings([
      { ...baseFinding, persona: 'security-tenancy' },
      { ...baseFinding, persona: 'policy-compliance' },
      { ...baseFinding, severity: 'P2', title: 'nit', persona: 'consistency' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('P1');
    expect(result[0].body).toContain('security-tenancy');
    expect(result[0].body).toContain('policy-compliance');
    expect(result[0].body).not.toContain('nit');
  });

  it('publishes every severity and ranks P0 before P1 before P2', () => {
    const result = dedupeActionableFindings([
      { ...baseFinding, severity: 'P2', title: 'style', persona: 'consistency' },
      { ...baseFinding, severity: 'P1', title: 'p1-a', path: 'b.ts', persona: 'a' },
      { ...baseFinding, severity: 'P0', title: 'p0-a', path: 'a.ts', persona: 'b' },
    ]);
    expect(result.map((f) => f.severity)).toEqual(['P0', 'P1', 'P2']);
    expect(result[0].path).toBe('a.ts');
  });

  it('publishes every finding by default and honors an explicit cap', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...baseFinding,
      path: `src/f${i}.ts`,
      line: i + 1,
      title: `finding-${i}`,
      persona: 'policy-compliance',
    }));
    const result = dedupeActionableFindings(many, { max: 5 });
    expect(result).toHaveLength(5);
    expect(MAX_FINAL_INLINE_COMMENTS).toBe(Infinity);
    expect(buildFinalInlineComments({ findings: many })).toHaveLength(30);
    expect(ACTIONABLE_SEVERITIES.has('P0')).toBe(true);
    expect(ACTIONABLE_SEVERITIES.has('P2')).toBe(false);
  });

  it('formats persona reports as advisory issue comments without merge-gate language', () => {
    const body = formatPersonaIssueComment(
      {
        id: 'security-tenancy',
        required: true,
        providerId: 'openrouter' as any,
        model: 'openai/gpt-5.6-luna',
        decision: 'FINDINGS',
        durationMs: 1200,
        usage: { prompt: 10, completion: 20, total: 30 },
        costUSD: 0.01,
        findings: [{ ...baseFinding }],
      },
      'abc123def456',
      { laneIndex: 1, laneTotal: 6, runId: 'run-9' },
    );

    expect(body).toContain(PERSONA_ISSUE_MARKER_PREFIX);
    expect(body).toContain('advisory');
    expect(body).toContain('do **not** open resolve-required review threads');
    expect(body).toContain('Lane: `1/6`');
    expect(body).toContain('Live tenant PII committed');
    expect(body).not.toMatch(/event:\s*COMMENT/);
  });

  it('buildFinalInlineComments maps every deduped finding', () => {
    const comments = buildFinalInlineComments({
      findings: [
        { ...baseFinding, persona: 'security-tenancy' },
        { ...baseFinding, persona: 'policy-compliance' },
        { ...baseFinding, severity: 'P2', title: 'nit', persona: 'consistency' },
      ],
    });
    expect(comments).toHaveLength(2);
    expect(comments[0].path).toBe('src/a.ts');
    expect(comments[0].finding.severity).toBe('major');
    expect(comments[0].finding.comment).toContain('Seen by personas');
  });

  it('formatFinalReviewBody stays compact without the finding ledger', () => {
    const body = formatFinalReviewBody({
      verdict: 'FIX_FIRST',
      rationale: 'P1 remains',
      summary: 'ledger',
      headSha: 'abc123',
      inlineCount: 2,
      totalActionableCandidates: 5,
      maxInline: 10,
    });
    expect(body).toContain('Review verdict: FIX_FIRST');
    expect(body).toContain('2');
    expect(body).not.toContain('ledger');
    expect(body).toContain('Head: `abc123`');
  });

  it('findingDedupeKey is stable for same path/line/severity/title', () => {
    const a = findingDedupeKey({ ...baseFinding, persona: 'a' });
    const b = findingDedupeKey({ ...baseFinding, persona: 'b' });
    expect(a).toBe(b);
  });
  it.each([['  return safe;', 9], ['  return safe;', null], ['', null]] as const)('carries structured replacement %j at start %j through to the GitHub payload', async (replacementCode, startLine) => {
    const schema: any = buildPanelResponseFormat('persona');
    const findingSchema = schema.json_schema.schema.properties.findings.items;
    expect(findingSchema.required).toContain('replacementCode');
    expect(findingSchema.required).toContain('startLine');
    const findings = validateFindings([{ ...baseFinding, startLine, replacementCode }]);
    const comments = buildFinalInlineComments({
      findings: findings.map(finding => ({ ...finding, persona: 'correctness' })),
      changedFiles: [{ path: baseFinding.path, patch: '@@ -9,2 +9,2 @@\n-old\n-old\n+  const unsafe = true;\n+  return unsafe;' }],
    });
    let payload: any;
    const publisher = new CommentPublisher({
      githubToken: 'ghs_test', maxRetries: 0,
      fetchImplementation: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      },
    });
    const result = await publisher.publishReview({ owner: 'o', repo: 'r', prNumber: 1, commitSha: 'abc', event: 'COMMENT', body: 'Review', inlineComments: comments });
    expect(result.success).toBe(true);
    expect(payload.comments[0]).toMatchObject({ line: 10, side: 'RIGHT' });
    expect(payload.comments[0].start_line).toBe(startLine ?? undefined);
    expect(payload.comments[0].body).toContain('```suggestion\n' + replacementCode + '\n```');
  });

  it.each([
    undefined,
    [{ path: baseFinding.path }],
    [{ path: baseFinding.path, patch: '@@ -10 +10,0 @@\n-old' }],
    [{ path: baseFinding.path, patch: '@@ -10 +10 @@\n-old\n+new' }],
  ])('withholds replacements without a proven complete RIGHT-side range (%j)', (changedFiles) => {
    const comments = buildFinalInlineComments({
      findings: [{ ...baseFinding, persona: 'security', startLine: 9, replacementCode: 'new', suggestion: 'Fix the unsafe code.' }],
      changedFiles,
    });
    expect(comments[0].finding.replacementCode).toBeUndefined();
    expect(formatInlineCommentBody(comments[0].finding)).not.toContain('```suggestion');
    expect(formatInlineCommentBody(comments[0].finding)).toContain('Fix the unsafe code.');
  });

  it('uses a file conversation when no patch is available', () => {
    const comments = buildFinalInlineComments({
      findings: [{ ...baseFinding, persona: 'security', replacementCode: 'safe();' }],
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: baseFinding.path, subjectType: 'file' });
    expect(comments[0].finding.replacementCode).toBeUndefined();
    expect(comments[0].finding.comment).toContain('Reported location: line 10');
  });

  it('preserves a deleted-line LEFT anchor without allowing a replacement', () => {
    const comments = buildFinalInlineComments({
      findings: [{ ...baseFinding, persona: 'security', replacementCode: 'safe();' }],
      changedFiles: [{ path: baseFinding.path, patch: '@@ -10 +10,0 @@\n-old' }],
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: baseFinding.path, line: 10, side: 'LEFT' });
    expect(comments[0].finding.replacementCode).toBeUndefined();
  });

  it('withholds conflicting replacement proposals for the same finding', () => {
    const result = dedupeActionableFindings([
      { ...baseFinding, persona: 'a', startLine: 9, replacementCode: 'first();' },
      { ...baseFinding, persona: 'b', startLine: 9, replacementCode: 'second();' },
      { ...baseFinding, persona: 'c', startLine: 9, replacementCode: 'first();' },
    ]);
    expect(result[0].replacementCode).toBeUndefined();
    expect(result[0].startLine).toBeUndefined();
  });

  it('keeps a duplicate replacement tied to its original range', () => {
    const result = dedupeActionableFindings([
      { ...baseFinding, persona: 'a', replacementCode: '  safe();' },
      { ...baseFinding, persona: 'b', startLine: 8 },
    ]);
    expect(result[0].replacementCode).toBe('  safe();');
    expect(result[0].startLine).toBeUndefined();
  });

});
