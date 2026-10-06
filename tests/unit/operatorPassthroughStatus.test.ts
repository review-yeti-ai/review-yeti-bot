import { describe, expect, it, vi } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { operatorPassthroughReadyForShip } from '../../src/review/operatorPassthrough';
import { AuthoritativeCandidateChangedError } from '../../src/review/authoritativePublishingResolver';

const candidate = {
  publication_id: 'a'.repeat(64), audit_digest: 'b'.repeat(64),
  owner: 'exampleorg', repo: 'example-repo', pr_number: 42,
  head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), policy_digest: 'e'.repeat(64),
  expected_app_id: 4385771, review_check_id: 7001, review_creation_state: 'bound',
  gate_check_id: 7002, gate_creation_state: 'bound', retirement_requested_at: null, retired_at: null,
};

const currentCandidate = {
  repositoryId: 123, owner: candidate.owner, repo: candidate.repo, prNumber: candidate.pr_number,
  headSha: candidate.head_sha, baseSha: candidate.base_sha, open: true, draft: false,
};

function statusOptions(overrides: Record<string, unknown> = {}) {
  return {
    passthroughEnabled: true,
    authoritativePublishing: {
      expectedAppId: candidate.expected_app_id,
      repositoryIds: [currentCandidate.repositoryId],
      resolver: { resolve: vi.fn(async () => ({ current: currentCandidate,
        prepared: { policy: { effectivePolicyDigest: candidate.policy_digest } } })) },
    },
    resolveGitHubPullRequest: vi.fn(async () => ({ headSha: currentCandidate.headSha,
      baseSha: currentCandidate.baseSha, repositoryId: currentCandidate.repositoryId })),
    ...overrides,
  } as any;
}

describe('get_review_status operator-passthrough projection', () => {
  it.each([
    ['both bound checks with numeric ids', {}, true],
    ['database bigint strings', { reviewCheckId: '7001', gateCheckId: '7002' }, true],
    ['an unresolved review check', { reviewCreationState: 'creating' }, false],
    ['a missing gate id', { gateCheckId: null }, false],
    ['a boolean check id', { reviewCheckId: true }, false],
    ['a non-decimal check id', { reviewCheckId: '7e3' }, false],
    ['a retirement request', { retirementRequestedAt: 1 }, false],
    ['a retired publication', { retiredAt: 1 }, false],
  ] as const)('uses one exact SHIP-readiness rule for %s', (_label, overrides, ready) => {
    expect(operatorPassthroughReadyForShip({
      reviewCreationState: 'bound', reviewCheckId: 7001,
      gateCreationState: 'bound', gateCheckId: 7002,
      retirementRequestedAt: null, retiredAt: null,
      ...overrides,
    })).toBe(ready);
  });

  it('reports explicit zero-lane SHIP from the durable paired-check publication without inventing a run', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [candidate] }));
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP',
      attempt_id: null, head_sha: candidate.head_sha, phase: 'completed',
      check_run: { id: 7002, conclusion: 'success' }, active_worker: null,
      operator_exemption: { publication_id: candidate.publication_id, audit_digest: candidate.audit_digest,
        base_sha: candidate.base_sha, policy_digest: candidate.policy_digest, expected_lanes: 0,
        completed_lanes: 0, review_started: false, publication_state: 'published',
        review_check_id: 7001, gate_check_id: 7002, merge_eligible: true },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('review_operator_passthrough_publications');
  });

  it('uses the same operator-publication projection with and without a head filter', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [candidate] }));
    const tool = createGetReviewStatusTool({ query }, statusOptions());
    await tool.execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: candidate.head_sha });
    await tool.execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });

    const projections = query.mock.calls.map(([sql]) => sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM'))
      .replace(/\s+/gu, ' ').trim());
    expect(projections).toHaveLength(2);
    expect(projections[0]).toBe(projections[1]);
    expect(projections[0]).toContain('review_creation_state');
    expect(projections[0]).toContain('retired_at');
  });

  it('shows truthful SHIP intent but not merge eligibility while official checks are unresolved', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ ...candidate, gate_check_id: null, gate_creation_state: 'creating' }] }));
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', phase: 'completed', check_run: null,
      operator_exemption: { publication_state: 'pending', merge_eligible: false, expected_lanes: 0, completed_lanes: 0 } });
  });

  it('keeps validated pause SHIP when reading the durable publication fails', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => { throw new Error('database unavailable'); });
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', phase: 'completed', check_run: null,
      operator_exemption: { publication_id: null, audit_digest: null, base_sha: candidate.base_sha,
        policy_digest: candidate.policy_digest, expected_app_id: candidate.expected_app_id,
        expected_lanes: 0, completed_lanes: 0, review_started: false,
        publication_state: 'unavailable', review_check_id: null, gate_check_id: null, merge_eligible: false },
      message: expect.stringContaining('publication is unavailable') });
  });

  it('keeps the pause verdict when a malformed durable receipt cannot be trusted', async () => {
    const malformedRow = { ...candidate, publication_id: 'not-a-publication-digest' };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [malformedRow] })
      .mockResolvedValue({ rows: [{ run_id: 'run_should_not_be_read', status: 'running' }] });
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ found: true, verdict: 'SHIP', phase: 'completed', check_run: null,
      head_sha: candidate.head_sha, attempt_id: null,
      message: expect.stringContaining('publication is unavailable'),
      operator_exemption: { publication_id: null, audit_digest: null,
        publication_state: 'unavailable', merge_eligible: false } });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('review_operator_passthrough_publications');
  });

  it('does not fall through to an old ordinary BLOCK run when a paused candidate has no receipt', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP',
      phase: 'completed', check_run: null, head_sha: candidate.head_sha, attempt_id: null,
      operator_exemption: { publication_state: 'unavailable', merge_eligible: false } });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('review_operator_passthrough_publications');
  });

  it('returns validated zero-lane SHIP with unavailable publication when the database is absent', async () => {
    const result = await createGetReviewStatusTool(undefined, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', operator_exemption: {
      publication_id: null, audit_digest: null, publication_state: 'unavailable', merge_eligible: false,
    } });
  });

  it('reports a closed candidate published historically without current merge eligibility', async () => {
    const query = vi.fn(async () => ({ rows: [candidate] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      resolver: { resolve: vi.fn(async () => { throw new AuthoritativeCandidateChangedError(); }) },
    } });
    const result = await createGetReviewStatusTool({ query }, options)
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
        head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', head_sha: candidate.head_sha,
      check_run: { id: candidate.gate_check_id, conclusion: 'success' },
      operator_exemption: { publication_state: 'published', publication_receipt_available: true,
        merge_eligible: false } });
    expect(value.message).toContain('historical candidate');
  });

  it('preserves a stale old-head receipt as historical SHIP with merge eligibility disabled', async () => {
    const oldHead = 'a'.repeat(40);
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ ...candidate, head_sha: oldHead }] }));
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: oldHead });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', head_sha: oldHead,
      operator_exemption: { publication_state: 'published', merge_eligible: false } });
    expect(query.mock.calls[0][1]).toEqual([candidate.owner, candidate.repo, candidate.pr_number, oldHead]);
  });

  it.each(['missing', 'unreadable'] as const)('does not issue stale-head SHIP when its receipt is %s', async (state) => {
    const query = vi.fn(async () => state === 'missing' ? { rows: [] } : Promise.reject(new Error('database unavailable')));
    const result = await createGetReviewStatusTool({ query }, statusOptions())
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: 'a'.repeat(40) });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: false, verdict: 'PENDING', phase: 'unknown' });
    expect(value).not.toHaveProperty('operator_exemption');
  });

  it('rejects an unenrolled repository before reading publication state', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const unadmittedTool = createGetReviewStatusTool({ query }, statusOptions({
      authoritativePublishing: { expectedAppId: candidate.expected_app_id, repositoryIds: [],
        resolver: { resolve: vi.fn() } },
    }));
    await expect(unadmittedTool.execute({ owner: candidate.owner, repo: candidate.repo,
      pull_number: candidate.pr_number })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
