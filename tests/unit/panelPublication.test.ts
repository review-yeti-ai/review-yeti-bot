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

    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('P1');
    expect(result[0].body).toContain('security-tenancy');
    expect(result[0].body).toContain('policy-compliance');
    expect(result[0].body).not.toContain('nit');
  });

  it('drops P2 from actionable threads and ranks P0 before P1', () => {
    const result = dedupeActionableFindings([
      { ...baseFinding, severity: 'P2', title: 'style', persona: 'consistency' },
      { ...baseFinding, severity: 'P1', title: 'p1-a', path: 'b.ts', persona: 'a' },
      { ...baseFinding, severity: 'P0', title: 'p0-a', path: 'a.ts', persona: 'b' },
    ]);
    expect(result.map((f) => f.severity)).toEqual(['P0', 'P1']);
    expect(result[0].path).toBe('a.ts');
  });

  it('caps final inline comments', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...baseFinding,
      path: `src/f${i}.ts`,
      line: i + 1,
      title: `finding-${i}`,
      persona: 'policy-compliance',
    }));
    const result = dedupeActionableFindings(many, { max: 5 });
    expect(result).toHaveLength(5);
    expect(MAX_FINAL_INLINE_COMMENTS).toBe(10);
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

  it('buildFinalInlineComments maps only deduped actionable findings', () => {
    const comments = buildFinalInlineComments({
      findings: [
        { ...baseFinding, persona: 'security-tenancy' },
        { ...baseFinding, persona: 'policy-compliance' },
        { ...baseFinding, severity: 'P2', title: 'nit', persona: 'consistency' },
      ],
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe('src/a.ts');
    expect(comments[0].finding.severity).toBe('major');
    expect(comments[0].finding.comment).toContain('Seen by personas');
  });

  it('formatFinalReviewBody documents deferred persona surface', () => {
    const body = formatFinalReviewBody({
      verdict: 'FIX_FIRST',
      rationale: 'P1 remains',
      summary: 'ledger',
      headSha: 'abc123',
      inlineCount: 2,
      totalActionableCandidates: 5,
      maxInline: 10,
    });
    expect(body).toContain('Binding arbiter verdict: FIX_FIRST');
    expect(body).toContain('2');
    expect(body).toContain('issue comments only');
  });

  it('findingDedupeKey is stable for same path/line/severity/title', () => {
    const a = findingDedupeKey({ ...baseFinding, persona: 'a' });
    const b = findingDedupeKey({ ...baseFinding, persona: 'b' });
    expect(a).toBe(b);
  });
});
