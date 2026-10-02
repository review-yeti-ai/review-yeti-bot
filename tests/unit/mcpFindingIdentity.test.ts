import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createExplainFindingTool } from '../../src/mcp/server/tools/explainFinding';
import { createGenerateFixDiffTool } from '../../src/mcp/server/tools/generateFixDiff';
import { createGetReviewFindingsTool } from '../../src/mcp/server/tools/getReviewFindings';
import {
  findReviewFindingRecord,
  getLegacyResourceFindingId,
  getReviewFindingId,
  newestReviewRowsPerRun,
} from '../../src/mcp/server/tools/findingIdentity';
import { fetchFindingsResource } from '../../src/mcp/server/resources/findingsResource';

function toolJson(result: any): any {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('native review finding identity', () => {
  it.each([{ path: 'src/line-only.ts', line: 18 }, { file: 'src/file-alias.ts', line: 20 }])('shares fallback coordinates with explain for %j', async (finding) => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ run_id: 'run-coordinates', payload: { findings: [{ ...finding, title: 'Coordinates', severity: 'P2' }] } }] }) };
    const args = { owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583 };
    const listed = toolJson(await createGetReviewFindingsTool(db).execute(args)).findings[0];
    const resource = await fetchFindingsResource(args.owner, args.repo, args.pull_number, db);
    const modelClient = { complete: vi.fn().mockResolvedValue({ content: '{"explanation":"Coordinates","satisfies_requirement":null}' }) };
    const caller = { authType: 'static_token' as const, tokenDigest: 'test-digest', isAdmin: false, allowedRepositories: new Set(['calltelemetry/ct-uat']), callerId: 'coordinate-test' };
    await createExplainFindingTool({ queryableDatabase: db, modelClient }).execute({ ...args, finding_id: listed.finding_id, question: 'What does this finding refer to?' }, { caller });
    expect(resource.findings[0]).toMatchObject({ file_path: listed.file_path, line_start: finding.line, line_end: finding.line });
    expect(modelClient.complete).toHaveBeenCalledOnce();
    expect(modelClient.complete.mock.calls[0][0].messages[1].content).toContain(`- Location: ${listed.file_path}:${finding.line}-${finding.line}`);
  });

  it('selects the greatest attempt from oldest-first rows and retains the first equal-attempt row', () => {
    const older = { run_id: 'run-ordered', execution_attempt: 1 }, newest = { run_id: 'run-ordered', execution_attempt: 2 };
    const other = { run_id: 'run-other', execution_attempt: 1 }, tie = { ...newest };
    expect(newestReviewRowsPerRun([older, newest, other, tie])).toEqual([newest, other]);
    expect(newestReviewRowsPerRun([older, newest, other, tie])[0]).toBe(newest);
  });

  it('keeps displayed IDs aligned across listing, resources, explain, and diff tools', async () => {
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
      ...target,
      line_end: 47,
      body: 'A separate persona noted the same code range.',
      suggestion: 'const attribution = "explicit-args";',
    };
    const payload = {
      result: {
        personas: [
          { id: 'security-reviewer', findings: [target] },
          { id: 'architecture-reviewer', findings: [sameStartDifferentPersona] },
        ],
      },
    };
    const runId = 'run-missing-finding-ids';
    const db = { query: vi.fn().mockResolvedValue({
      rows: [{ run_id: runId, execution_attempt: 3, head_sha: 'a'.repeat(40), payload }],
    }) };

    const listed = toolJson(await createGetReviewFindingsTool(db).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583,
    }));
    expect(listed.findings).toHaveLength(2);
    const selected = listed.findings.find((finding: any) => finding.line_end === 47);
    const untouched = listed.findings.find((finding: any) => finding.line_end === 44);
    expect(selected.finding_id).toBe(getReviewFindingId(runId, 'architecture-reviewer', sameStartDifferentPersona));
    expect(selected.finding_id).not.toBe(untouched.finding_id);

    const resource = await fetchFindingsResource('calltelemetry', 'ct-uat', 1583, db);
    expect(resource.findings.find((finding) => finding.line_end === 47)?.finding_id).toBe(selected.finding_id);

    const modelClient = { complete: vi.fn().mockResolvedValue({
      content: '{"explanation":"The selected line-47 finding was loaded.","satisfies_requirement":true}',
    }) };
    const caller = {
      authType: 'static_token' as const,
      tokenDigest: 'test-digest',
      isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/ct-uat']),
      callerId: 'finding-identity-test',
    };
    const explanation = toolJson(await createExplainFindingTool({ queryableDatabase: db, modelClient }).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583,
      finding_id: selected.finding_id, question: 'What does this finding refer to?',
    }, { caller }));
    expect(modelClient.complete).toHaveBeenCalledOnce();
    expect(explanation.explanation).toContain('line-47');

    const fix = toolJson(await createGenerateFixDiffTool({ queryableDatabase: db }).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pr_number: 1583, finding_id: selected.finding_id,
    }));
    expect(fix.replacement_lines).toBe('const attribution = "explicit-args";');
  });

  it('uses the newest completion for each logical run when listing findings', async () => {
    const olderFinding = {
      finding_id: 'stable-finding-id', title: 'Finding from the older execution attempt',
      severity: 'P2', path: 'src/review/retried.ts', line: 18, attemptMarker: 'older',
    };
    const newestFinding = { ...olderFinding, title: 'Finding from the newest execution attempt', attemptMarker: 'newest' };
    const runId = 'run-repeated-execution-attempts';
    const rows = [
      { run_id: runId, execution_attempt: 2, payload: { findings: [newestFinding] } },
      { run_id: runId, execution_attempt: 1, payload: { findings: [olderFinding] } },
    ];
    const listed = toolJson(await createGetReviewFindingsTool({
      query: vi.fn().mockResolvedValue({ rows }),
    }).execute({ owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583 }));

    expect(listed.findings).toHaveLength(1);
    expect(listed.findings[0]).toMatchObject({ finding_id: 'stable-finding-id', title: newestFinding.title });
    expect(newestReviewRowsPerRun(rows)).toEqual([rows[0]]);
  });

  it('preserves truthy embedded IDs and uses stable fallback IDs for falsey embedded values', async () => {
    const payload = { findings: [
      { finding_id: 'canonical-embedded-id', id: 'legacy-alias-id', title: 'Embedded', severity: 'P2', path: 'src/review/example.ts', line: 9 },
      { finding_id: 0, id: false, title: 'Falsey', severity: 'P2', path: 'src/review/falsey-id.ts', line: 12 },
    ] };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ run_id: 'run-embedded-id', execution_attempt: 1, payload }] }) };
    const listed = toolJson(await createGetReviewFindingsTool(db).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583,
    }));

    expect(listed.findings[0].finding_id).toBe('canonical-embedded-id');
    expect(listed.findings[1].finding_id).toBe(getReviewFindingId('run-embedded-id', 'reviewer', payload.findings[1]));
    expect(listed.findings[1].finding_id).not.toBe('0');
    expect(listed.findings[1].finding_id).not.toBe('false');
    const resource = await fetchFindingsResource('calltelemetry', 'ct-uat', 1583, db);
    expect(resource.findings[0].finding_id).toBe('canonical-embedded-id');
  });

  it('accepts a cached resource hash as a unique legacy alias when the finding has an embedded ID', () => {
    const finding = {
      finding_id: 'canonical-embedded-id',
      title: 'Embedded identity suppresses the old fallback hash',
      path: 'src/review/embedded.ts', line_start: 9, line_end: 11,
    };
    const legacyResourceId = getLegacyResourceFindingId('run-embedded-alias', finding);
    const records = [{ finding, personaId: 'reviewer', runId: 'run-embedded-alias' }];

    expect(findReviewFindingRecord(records, 'canonical-embedded-id')).toBe(records[0]);
    expect(findReviewFindingRecord(records, legacyResourceId)).toBe(records[0]);
  });

  it('accepts a cached resource hash only when it identifies one candidate', async () => {
    const finding = {
      title: 'Cached resource finding remains addressable', severity: 'P2', path: 'src/review/cached.ts',
      line_start: 22, line_end: 26, originalCode: 'oldValue();', suggestion: 'newValue();',
    };
    const runId = 'run-cached-resource-id';
    const legacyResourceId = createHash('sha256')
      .update(`${runId}:${finding.path}:${finding.line_start}:${finding.title}`).digest('hex').slice(0, 16);
    const db = { query: vi.fn().mockResolvedValue({
      rows: [{ run_id: runId, payload: { result: { personas: [{ id: 'testing-reviewer', findings: [finding] }] } } }],
    }) };

    const fix = toolJson(await createGenerateFixDiffTool({ queryableDatabase: db }).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pr_number: 1583, finding_id: legacyResourceId,
    }));
    expect(fix.file_path).toBe(finding.path);
    expect(fix.replacement_lines).toBe('newValue();');
  });

  it('rejects a legacy resource hash that collides across persona or end-line candidates', () => {
    const shared = { title: 'Same short identity fields', severity: 'P2', path: 'src/review/collision.ts', line_start: 30 };
    const records = [
      { finding: { ...shared, line_end: 31 }, personaId: 'reviewer-a', runId: 'run-short-hash-collision' },
      { finding: { ...shared, line_end: 35 }, personaId: 'reviewer-b', runId: 'run-short-hash-collision' },
    ];
    const ambiguousLegacyId = createHash('sha256')
      .update(`run-short-hash-collision:${shared.path}:${shared.line_start}:${shared.title}`).digest('hex').slice(0, 16);

    expect(findReviewFindingRecord(records, ambiguousLegacyId)).toBeNull();
    expect(findReviewFindingRecord(records, getReviewFindingId(records[0].runId, records[0].personaId, records[0].finding)))
      .toBe(records[0]);
  });

  it('prefers an authoritative canonical ID over another finding losing id alias', () => {
    const losingAlias = {
      finding_id: 'authoritative-first', id: 'authoritative-second', title: 'First finding with a losing alias',
      severity: 'P2', path: 'src/review/first.ts', line: 4,
    };
    const authoritativeMatch = {
      finding_id: 'authoritative-second', title: 'Second finding owns requested identity',
      severity: 'P2', path: 'src/review/second.ts', line: 8,
    };
    const records = [
      { finding: losingAlias, personaId: 'reviewer', runId: 'run-canonical-priority' },
      { finding: authoritativeMatch, personaId: 'reviewer', runId: 'run-canonical-priority' },
    ];

    expect(findReviewFindingRecord(records, 'authoritative-second')).toBe(records[1]);
  });

  it('keeps explain_finding support for legacy payload.result.findings', async () => {
    const finding = {
      id: 'legacy-result-finding-id', title: 'Legacy result finding is still explainable',
      severity: 'P2', path: 'src/review/legacy-result.ts', line: 17,
    };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{
      run_id: 'run-legacy-result', owner: 'calltelemetry', repo: 'ct-uat', payload: { result: { findings: [finding] } },
    }] }) };
    const modelClient = { complete: vi.fn().mockResolvedValue({
      content: '{"explanation":"The legacy result shape was found.","satisfies_requirement":true}',
    }) };
    const caller = {
      authType: 'static_token' as const, tokenDigest: 'legacy-result-test-digest', isAdmin: false,
      allowedRepositories: new Set(['calltelemetry/ct-uat']), callerId: 'legacy-result-test',
    };

    const explanation = toolJson(await createExplainFindingTool({ queryableDatabase: db, modelClient }).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583,
      finding_id: finding.id, question: 'Explain this older persisted finding.',
    }, { caller }));

    expect(modelClient.complete).toHaveBeenCalledOnce();
    expect(explanation.explanation).toContain('legacy result shape');
  });

  it.each([
    { personaId: 'security-reviewer', expectedPersona: 'security-reviewer' },
    { persona: 'testing-reviewer', expectedPersona: 'testing-reviewer' },
    { expectedPersona: 'reviewer' },
  ])('uses displayed top-level identity with $expectedPersona attribution', async ({ personaId, persona, expectedPersona }) => {
    const finding = {
      ...(personaId ? { personaId } : {}), ...(persona ? { persona } : {}),
      title: 'A top-level finding without a stored ID', severity: 'P2', path: 'src/review/top-level.ts', line_start: 6, line_end: 8,
    };
    const runId = 'run-top-level';
    const payload = { findings: [finding] };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ run_id: runId, execution_attempt: 2, payload }] }) };
    const listed = toolJson(await createGetReviewFindingsTool(db).execute({
      owner: 'calltelemetry', repo: 'ct-uat', pull_number: 1583,
    }));

    expect(listed.findings[0].finding_id).toBe(getReviewFindingId(runId, expectedPersona, finding));
    expect(findReviewFindingRecord([{ finding, personaId: expectedPersona, runId }], listed.findings[0].finding_id))
      .toMatchObject({ finding, personaId: expectedPersona, runId });
  });
});
