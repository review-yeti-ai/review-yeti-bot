import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';
import { createGenerateFixDiffTool } from '../../src/mcp/server/tools/generateFixDiff';
import { createGetReviewFindingsTool } from '../../src/mcp/server/tools/getReviewFindings';
import { findReviewFindingRecord, getLegacyResourceFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { fetchFindingsResource } from '../../src/mcp/server/resources/findingsResource';

function toolJson(result: any): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('native review finding identity', () => {
  it('lets a displayed fallback ID dispute only its persisted completion finding', async () => {
    const target = {
      title: 'Tenant lookup must use the canonical worker name',
      severity: 'P1',
      path: 'lib/cdrcisco/oban/history.ex',
      line_start: 40,
      line_end: 44,
      body: 'The exact serialized worker name is checked before trusting metadata.',
      originalCode: 'const attribution = "alias";',
      suggestion: 'const attribution = "canonical";',
    };
    const sameStartDifferentPersona = {
      title: target.title,
      severity: 'P1',
      path: target.path,
      line_start: target.line_start,
      line_end: 47,
      body: 'A separate persona noted the same code range.',
      originalCode: 'const attribution = "alias";',
      suggestion: 'const attribution = "explicit-args";',
    };
    let persistedPayload: any = {
      result: {
        personas: [
          { id: 'security-reviewer', findings: [target] },
          { id: 'architecture-reviewer', findings: [sameStartDifferentPersona] },
        ],
      },
    };
    const runId = 'run-missing-finding-ids';
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('UPDATE review_worker_completions')) {
          persistedPayload = JSON.parse(String(values?.[0]));
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO review_finding_disputes')) {
          return { rows: [] };
        }
        return {
          rows: [{
            run_id: runId,
            execution_attempt: 3,
            head_sha: 'a'.repeat(40),
            payload: persistedPayload,
          }],
        };
      }),
    };

    const getFindings = createGetReviewFindingsTool(db);
    const listedBefore = toolJson(await getFindings.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
    }));
    expect(listedBefore.findings).toHaveLength(2);
    const selected = listedBefore.findings.find((finding: any) => finding.line_end === 47);
    const untouched = listedBefore.findings.find((finding: any) => finding.line_end === 44);
    expect(selected.finding_id).not.toBe(untouched.finding_id);

    const findingsResource = await fetchFindingsResource('calltelemetry', 'ct-uat', 1583, db);
    expect(findingsResource.findings.find((finding) => finding.line_end === 47)?.finding_id)
      .toBe(selected.finding_id);

    const modelClient = {
      complete: vi.fn().mockResolvedValue({
        content: '{"explanation":"The selected line-47 finding was loaded.","satisfies_requirement":true}',
      }),
    };
    const explainFinding = createExplainFindingTool({ queryableDatabase: db, modelClient });
    const caller = {
      authType: 'static_token' as const,
      tokenDigest: 'test-digest',
      isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/ct-uat']),
      callerId: 'finding-identity-test',
    };
    const explanation = toolJson(await explainFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
      finding_id: selected.finding_id,
      question: 'What does this finding refer to?',
    }, { caller }));
    expect(modelClient.complete).toHaveBeenCalledOnce();
    expect(explanation.explanation).toContain('line-47');

    const generateFixDiff = createGenerateFixDiffTool({ queryableDatabase: db });
    const fix = toolJson(await generateFixDiff.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: selected.finding_id,
    }));
    expect(fix.replacement_lines).toBe('const attribution = "explicit-args";');

    const adjudicateDispute = vi.fn().mockResolvedValue({
      verdict: 'overruled',
      reasoning: 'The canonical serialized worker name is already validated.',
      confidence: 0.95,
    });
    const disputeFinding = createDisputeFindingTool({ queryableDatabase: db, adjudicateDispute });
    const dispute = toolJson(await disputeFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: selected.finding_id,
      counter_argument: 'The persisted Oban worker name is canonical and the API validates it before reading tenant metadata.',
    }));

    expect(dispute.finding_id).toBe(selected.finding_id);
    expect(dispute.verdict).toBe('overruled');
    expect(adjudicateDispute).toHaveBeenCalledWith(
      expect.objectContaining({ title: target.title, line_end: 47 }),
      expect.any(String),
      expect.objectContaining({ owner: 'calltelemetry', repo: 'ct-uat', pr_number: 1583 }),
    );
    expect(persistedPayload.result.personas[0].findings[0]).not.toHaveProperty('resolved');
    expect(persistedPayload.result.personas[1].findings[0]).toMatchObject({
      resolved: true,
      status: 'OVERRULED',
    });

    const listedAfter = toolJson(await getFindings.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
      unresolved_only: false,
    }));
    expect(listedAfter.findings.find((finding: any) => finding.line_end === 47).finding_id)
      .toBe(selected.finding_id);
    const resourceAfter = await fetchFindingsResource('calltelemetry', 'ct-uat', 1583, db);
    expect(resourceAfter.findings.find((finding) => finding.line_end === 47)?.finding_id)
      .toBe(selected.finding_id);
  });

  it('uses the newest completion for a logical run when resolving a displayed finding ID', async () => {
    const olderFinding = {
      finding_id: 'stable-finding-id',
      title: 'Finding from the older execution attempt',
      severity: 'P2',
      path: 'src/review/retried.ts',
      line: 18,
      attemptMarker: 'older',
    };
    const newestFinding = {
      ...olderFinding,
      title: 'Finding from the newest execution attempt',
      attemptMarker: 'newest',
    };
    const runId = 'run-repeated-execution-attempts';
    const rows = [
      { run_id: runId, execution_attempt: 2, payload: { findings: [newestFinding] } },
      { run_id: runId, execution_attempt: 1, payload: { findings: [olderFinding] } },
    ];
    const updates: Array<{ payload: any; runId: string; executionAttempt: number }> = [];
    const disputeAudits: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('UPDATE review_worker_completions')) {
          updates.push({
            payload: JSON.parse(String(values?.[0])),
            runId: String(values?.[1]),
            executionAttempt: Number(values?.[2]),
          });
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO review_finding_disputes')) {
          disputeAudits.push(values || []);
          return { rows: [] };
        }
        return { rows };
      }),
    };

    const listed = toolJson(await createGetReviewFindingsTool(db).execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
    }));
    expect(listed.findings).toHaveLength(1);
    expect(listed.findings[0]).toMatchObject({
      finding_id: 'stable-finding-id',
      title: newestFinding.title,
    });

    const adjudicateDispute = vi.fn().mockResolvedValue({
      verdict: 'overruled',
      reasoning: 'The newest completion is the current finding record.',
      confidence: 0.9,
    });
    await createDisputeFindingTool({ queryableDatabase: db, adjudicateDispute }).execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: listed.findings[0].finding_id,
      counter_argument: 'This argument addresses the current finding in the newest attempt.',
    });

    expect(adjudicateDispute).toHaveBeenCalledWith(
      expect.objectContaining({ title: newestFinding.title, attemptMarker: 'newest' }),
      expect.any(String),
      expect.any(Object),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      runId,
      executionAttempt: 2,
      payload: { findings: [expect.objectContaining({ status: 'OVERRULED', attemptMarker: 'newest' })] },
    });
    expect(disputeAudits).toHaveLength(1);
    expect(disputeAudits[0]).toEqual([
      'stable-finding-id',
      'calltelemetry',
      'ct-uat',
      1583,
      expect.any(String),
      'overruled',
      'The newest completion is the current finding record.',
    ]);
  });

  it('preserves embedded finding IDs ahead of a legacy id field', async () => {
    const payload = {
      findings: [
        {
          finding_id: 'canonical-embedded-id',
          id: 'legacy-alias-id',
          title: 'Embedded identity remains authoritative',
          severity: 'P2',
          path: 'src/review/example.ts',
          line: 9,
        },
        {
          finding_id: 0,
          id: false,
          title: 'Falsey embedded identities retain fallback behavior',
          severity: 'P2',
          path: 'src/review/falsey-id.ts',
          line: 12,
        },
      ],
    };
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ run_id: 'run-embedded-id', execution_attempt: 1, payload }],
      }),
    };
    const getFindings = createGetReviewFindingsTool(db);
    const listed = toolJson(await getFindings.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
    }));

    expect(listed.findings[0].finding_id).toBe('canonical-embedded-id');
    expect(listed.findings[1].finding_id).not.toBe('0');
    expect(listed.findings[1].finding_id).not.toBe('false');
    const disputeFinding = createDisputeFindingTool({
      queryableDatabase: db,
      adjudicateDispute: vi.fn().mockResolvedValue({
        verdict: 'upheld',
        reasoning: 'The embedded identity remains canonical.',
        confidence: 0.9,
      }),
    });
    const disputed = toolJson(await disputeFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: 'canonical-embedded-id',
      counter_argument: 'This is a sufficient technical argument to run the test adjudicator.',
    }));
    expect(disputed.finding_id).toBe('canonical-embedded-id');
    const resource = await fetchFindingsResource('calltelemetry', 'ct-uat', 1583, db);
    expect(resource.findings[0].finding_id).toBe('canonical-embedded-id');
  });

  it('accepts a cached resource hash as a unique legacy alias when the finding has an embedded ID', () => {
    const embedded = {
      finding_id: 'canonical-embedded-id',
      title: 'Embedded identity suppresses the old fallback hash',
      path: 'src/review/embedded.ts',
      line_start: 9,
      line_end: 11,
    };
    const legacyResourceId = getLegacyResourceFindingId('run-embedded-alias', embedded);
    const records = [{
      finding: embedded,
      personaId: 'reviewer',
      runId: 'run-embedded-alias',
    }];

    expect(findReviewFindingRecord(records, 'canonical-embedded-id')).toBe(records[0]);
    expect(findReviewFindingRecord(records, legacyResourceId)).toBe(records[0]);
  });

  it('accepts a cached resource hash only when it identifies one candidate', async () => {
    const finding = {
      title: 'Cached resource finding remains addressable',
      severity: 'P2',
      path: 'src/review/cached.ts',
      line_start: 22,
      line_end: 26,
      originalCode: 'oldValue();',
      suggestion: 'newValue();',
    };
    const runId = 'run-cached-resource-id';
    const legacyResourceId = createHash('sha256')
      .update(`${runId}:${finding.path}:${finding.line_start}:${finding.title}`)
      .digest('hex')
      .slice(0, 16);
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ run_id: runId, payload: { result: { personas: [{ id: 'testing-reviewer', findings: [finding] }] } } }],
      }),
    };

    const generateFixDiff = createGenerateFixDiffTool({ queryableDatabase: db });
    const fix = toolJson(await generateFixDiff.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: legacyResourceId,
    }));

    expect(fix.file_path).toBe(finding.path);
    expect(fix.replacement_lines).toBe('newValue();');
  });

  it('rejects a legacy resource hash that collides across persona or end-line candidates', async () => {
    const shared = {
      title: 'Same short identity fields',
      severity: 'P2',
      path: 'src/review/collision.ts',
      line_start: 30,
    };
    const payload = {
      result: {
        personas: [
          { id: 'reviewer-a', findings: [{ ...shared, line_end: 31 }] },
          { id: 'reviewer-b', findings: [{ ...shared, line_end: 35 }] },
        ],
      },
    };
    const runId = 'run-short-hash-collision';
    const ambiguousLegacyId = createHash('sha256')
      .update(`${runId}:${shared.path}:${shared.line_start}:${shared.title}`)
      .digest('hex')
      .slice(0, 16);
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{ run_id: runId, payload }] }),
    };
    const adjudicateDispute = vi.fn();
    const disputeFinding = createDisputeFindingTool({ queryableDatabase: db, adjudicateDispute });

    await expect(disputeFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: ambiguousLegacyId,
      counter_argument: 'This is a specific counterargument to the recorded source lines.',
    })).rejects.toThrow('was not found in review ledger');
    expect(adjudicateDispute).not.toHaveBeenCalled();
  });

  it('prefers an authoritative canonical ID over another finding losing id alias', async () => {
    const losingAlias = {
      finding_id: 'authoritative-first',
      id: 'authoritative-second',
      title: 'First finding with a losing alias',
      severity: 'P2',
      path: 'src/review/first.ts',
      line: 4,
    };
    const authoritativeMatch = {
      finding_id: 'authoritative-second',
      title: 'Second finding owns requested identity',
      severity: 'P2',
      path: 'src/review/second.ts',
      line: 8,
    };
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [{
        run_id: 'run-canonical-priority',
        payload: { findings: [losingAlias, authoritativeMatch] },
      }] }),
    };
    const adjudicateDispute = vi.fn().mockResolvedValue({
      verdict: 'upheld',
      reasoning: 'The authoritative second finding was selected.',
      confidence: 0.9,
    });
    const disputeFinding = createDisputeFindingTool({ queryableDatabase: db, adjudicateDispute });

    await disputeFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: 'authoritative-second',
      counter_argument: 'This specific counterargument preserves the finding for review.',
    });

    expect(adjudicateDispute).toHaveBeenCalledWith(
      expect.objectContaining({ title: authoritativeMatch.title }),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('keeps explain_finding support for legacy payload.result.findings', async () => {
    const finding = {
      id: 'legacy-result-finding-id',
      title: 'Legacy result finding is still explainable',
      severity: 'P2',
      path: 'src/review/legacy-result.ts',
      line: 17,
    };
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ run_id: 'run-legacy-result', owner: 'calltelemetry', repo: 'ct-uat', payload: { result: { findings: [finding] } } }],
      }),
    };
    const modelClient = {
      complete: vi.fn().mockResolvedValue({
        content: '{"explanation":"The legacy result shape was found.","satisfies_requirement":true}',
      }),
    };
    const caller = {
      authType: 'static_token' as const,
      tokenDigest: 'legacy-result-test-digest',
      isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/ct-uat']),
      callerId: 'legacy-result-test',
    };
    const explainFinding = createExplainFindingTool({ queryableDatabase: db, modelClient });

    const explanation = toolJson(await explainFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
      finding_id: finding.id,
      question: 'Explain this older persisted finding.',
    }, { caller }));

    expect(modelClient.complete).toHaveBeenCalledOnce();
    expect(explanation.explanation).toContain('legacy result shape');
  });

  it.each([
    { personaId: 'security-reviewer', expectedPersona: 'security-reviewer' },
    { persona: 'testing-reviewer', expectedPersona: 'testing-reviewer' },
    { expectedPersona: 'reviewer' },
  ])('uses the displayed top-level finding identity for dispute lookup with $expectedPersona attribution', async ({ personaId, persona }) => {
    const finding = {
      ...(personaId ? { personaId } : {}),
      ...(persona ? { persona } : {}),
      title: 'A top-level finding without a stored ID',
      severity: 'P2',
      path: 'src/review/top-level.ts',
      line_start: 6,
      line_end: 8,
    };
    const payload = { findings: [finding] };
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ run_id: 'run-top-level', execution_attempt: 2, payload }],
      }),
    };
    const getFindings = createGetReviewFindingsTool(db);
    const listed = toolJson(await getFindings.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pull_number: 1583,
    }));
    const disputeFinding = createDisputeFindingTool({
      queryableDatabase: db,
      adjudicateDispute: vi.fn().mockResolvedValue({
        verdict: 'upheld',
        reasoning: 'The finding remains supported.',
        confidence: 0.9,
      }),
    });

    const disputed = toolJson(await disputeFinding.execute({
      owner: 'calltelemetry',
      repo: 'ct-uat',
      pr_number: 1583,
      finding_id: listed.findings[0].finding_id,
      counter_argument: 'This counterargument includes sufficient technical detail to invoke the audited adjudicator.',
    }));

    expect(disputed.finding_id).toBe(listed.findings[0].finding_id);
    expect(disputed.verdict).toBe('upheld');
  });
});
