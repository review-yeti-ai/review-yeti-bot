import { describe, expect, it } from 'vitest';

import { runFindingReflection } from '../../src/review/reviewReflection';

const identity = {
  repository: 'owner/repository',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  configDigest: 'c'.repeat(64),
  policyDigest: 'd'.repeat(64),
};

const patch = '@@ -1,7 +1,7 @@\n-old1\n+new1\n-old2\n+new2\n-old3\n+new3\n-old4\n+new4\n-old5\n+new5\n-old6\n+new6\n-old7\n+new7';
const changedFiles = [{ path: 'src/app.js', patch }];
const exactBlobSnapshot = {
  identity,
  files: [{ path: 'src/app.js', patch, content: 'new1\nnew2\nnew3\nnew4\nnew5\nnew6\nnew7' }],
};

function finding(severity: 'P0' | 'P1' | 'P2', line: number, title = `${severity}-${line}`) {
  return {
    severity,
    path: 'src/app.js',
    side: 'RIGHT',
    line,
    title,
    body: `Candidate body for ${title}.`,
  };
}

function response(decision: 'KEEP' | 'DOWNGRADE' | 'DROP' | 'NEEDS_REVIEW', severity?: 'P0' | 'P1' | 'P2') {
  return {
    ok: true,
    content: JSON.stringify({ complete: true, decision, ...(severity ? { severity } : {}) }),
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, costUSD: 0.01 },
  };
}

function baseInput(findings: Array<Record<string, unknown>>, reflectTurn: (input: any) => Promise<Record<string, unknown>>, extra = {}) {
  return {
    findings,
    changedFiles,
    exactBlobSnapshot,
    identity,
    reflectTurn,
    ...extra,
  };
}

describe('shadow finding reflection', () => {
  it('reflects no more than five verified candidates in deterministic severity and finding-key order with concurrency two', async () => {
    let active = 0;
    let maxActive = 0;
    const calls: Array<{ severity: string; findingKey: string; content: string }> = [];
    const findings = [
      finding('P2', 7), finding('P1', 4), finding('P0', 3), finding('P2', 2),
      finding('P1', 6), finding('P0', 1), finding('P2', 5),
    ];
    const allTitles = findings.map((candidate) => candidate.title);

    const result = await runFindingReflection(baseInput(findings, async (turn) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({
        severity: turn.candidate.severity,
        findingKey: turn.verification.findingKey,
        content: turn.messages[1].content,
      });
      await new Promise((resolve) => setTimeout(resolve, turn.candidate.line % 2));
      active -= 1;
      return response('KEEP');
    }));

    expect(calls).toHaveLength(5);
    expect(maxActive).toBe(2);
    expect(result.receipt.summary).toMatchObject({ candidates: 5, kept: 5, overflow: 2, incomplete: true });
    expect(result.receipt.reflections.map((row: any) => row.originalSeverity)).toEqual(['P0', 'P0', 'P1', 'P1', 'P2']);
    for (const severity of ['P0', 'P1', 'P2']) {
      const keys = result.receipt.reflections
        .filter((row: any) => row.originalSeverity === severity)
        .map((row: any) => row.findingKey);
      expect(keys).toEqual([...keys].sort());
    }
    for (const call of calls) {
      const ownTitle = JSON.parse(call.content.match(/<candidate_finding>\n([\s\S]*?)\n<\/candidate_finding>/u)![1]).title;
      expect(allTitles.filter((title) => call.content.includes(title))).toEqual([ownTitle]);
    }
  });

  it('applies KEEP, DOWNGRADE, and P2 DROP without allowing P0 or P1 disagreement to drop a finding', async () => {
    const findings = [finding('P0', 1), finding('P1', 2), finding('P1', 3), finding('P2', 4), finding('P2', 5)];
    const result = await runFindingReflection(baseInput(findings, async ({ candidate }) => {
      if (candidate.line === 1 || candidate.line === 2) return response('DROP');
      if (candidate.line === 3) return response('DOWNGRADE', 'P2');
      if (candidate.line === 4) return response('DROP');
      return response('KEEP');
    }));

    expect(result.receipt.reflections
      .map((row: any) => ({ line: row.line, status: row.status, severity: row.severity, reasonCode: row.reasonCode }))
      .sort((left: any, right: any) => left.line - right.line)).toEqual([
      { line: 1, status: 'NEEDS_REVIEW', severity: 'P0', reasonCode: 'high_severity_disagreement' },
      { line: 2, status: 'NEEDS_REVIEW', severity: 'P1', reasonCode: 'high_severity_disagreement' },
      { line: 3, status: 'DOWNGRADE', severity: 'P2', reasonCode: 'downgraded' },
      { line: 4, status: 'DROP', severity: undefined, reasonCode: 'dropped' },
      { line: 5, status: 'KEEP', severity: 'P2', reasonCode: 'kept' },
    ]);
    expect(result.findings.map((row: any) => [row.line, row.severity])).toEqual([[1, 'P0'], [2, 'P1'], [3, 'P2'], [5, 'P2']]);
    expect(result.receipt.summary).toEqual({ candidates: 5, kept: 1, downgraded: 1, dropped: 1, needsReview: 2, overflow: 0, incomplete: true });
  });

  it('retains candidates as NEEDS_REVIEW for malformed, timed out, or incomplete turns and never accepts a replacement finding', async () => {
    const findings = [finding('P2', 1), finding('P2', 2), finding('P2', 3)];
    const expectedFindings = structuredClone(findings);
    const result = await runFindingReflection(baseInput(findings, async ({ candidate }) => {
      if (candidate.line === 1) return { ok: true, content: '{not-json' };
      if (candidate.line === 2) return new Promise(() => {});
      candidate.title = 'invented replacement';
      return {
        ok: true,
        content: JSON.stringify({
          complete: false,
          decision: 'KEEP',
          finding: finding('P0', 7, 'invented replacement'),
        }),
      };
    }, { limits: { timeoutMs: 5 } }));

    expect(result.receipt.reflections
      .map((row: any) => [row.line, row.status, row.reasonCode])
      .sort((left: any, right: any) => left[0] - right[0])).toEqual([
      [1, 'NEEDS_REVIEW', 'malformed_response'],
      [2, 'NEEDS_REVIEW', 'timeout'],
      [3, 'NEEDS_REVIEW', 'incomplete_response'],
    ]);
    expect([...result.findings].sort((left: any, right: any) => left.line - right.line)).toEqual(expectedFindings);
    expect(JSON.stringify(result.receipt)).not.toContain('invented replacement');
  });

  it('enforces aggregate call, token, concurrency, timeout, and inherited trusted cost ceilings', async () => {
    const calls: any[] = [];
    const result = await runFindingReflection(baseInput(
      [finding('P2', 1), finding('P2', 2), finding('P2', 3), finding('P2', 4), finding('P2', 5), finding('P2', 6)],
      async (turn) => {
        calls.push(turn);
        return response('KEEP');
      },
      {
        limits: { maxCandidates: 99, maxCalls: 99, maxTokens: 999_999, concurrency: 99, timeoutMs: 99_999 },
        trustedCostCeilingUSD: 1,
      },
    ));

    expect(calls).toHaveLength(5);
    expect(calls.every((turn) => turn.maxTokens === 6_400)).toBe(true);
    expect(calls.every((turn) => turn.timeoutMs === 30_000)).toBe(true);
    expect(calls.every((turn) => turn.costCeilingUSD === 0.2)).toBe(true);
    expect(result.receipt.limits).toEqual({ maxCandidates: 5, maxCalls: 5, maxTokens: 32_000, concurrency: 2, timeoutMs: 30_000, trustedCostCeilingUSD: 1 });
    expect(result.receipt.usage).toEqual({ promptTokens: 50, completionTokens: 10, totalTokens: 60, costUSD: 0.05 });
  });

  it('reuses exact finding verification and does not reflect rejected or incomplete anchors', async () => {
    let calls = 0;
    const rejected = finding('P1', 99, 'invalid anchor');
    const result = await runFindingReflection(baseInput([rejected], async () => {
      calls += 1;
      return response('KEEP');
    }));

    expect(calls).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.verification.verifications).toEqual([
      expect.objectContaining({ status: 'rejected', reasonCode: 'invalid_anchor' }),
    ]);
    expect(result.receipt.summary).toEqual({ candidates: 0, kept: 0, downgraded: 0, dropped: 0, needsReview: 0, overflow: 0, incomplete: false });

    const incomplete = await runFindingReflection({
      ...baseInput([finding('P1', 1)], async () => response('KEEP')),
      exactBlobSnapshot: { ...exactBlobSnapshot, identity: { ...identity, headSha: 'e'.repeat(40) } },
    });
    expect(incomplete.receipt.summary).toMatchObject({ candidates: 0, incomplete: true });
    expect(incomplete.verification.verifications[0]).toMatchObject({ status: 'needs_review', reasonCode: 'identity_mismatch' });
  });
});
