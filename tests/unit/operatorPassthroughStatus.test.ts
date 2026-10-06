import { describe, expect, it, vi } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { operatorPassthroughReadyForShip } from '../../src/review/operatorPassthrough';

const candidate = {
  publication_id: 'a'.repeat(64), audit_digest: 'b'.repeat(64),
  owner: 'exampleorg', repo: 'example-repo', pr_number: 42,
  head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), policy_digest: 'e'.repeat(64),
  expected_app_id: 15368, review_check_id: 7001, review_creation_state: 'bound',
  gate_check_id: 7002, gate_creation_state: 'bound', retirement_requested_at: null, retired_at: null,
};

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
    const result = await createGetReviewStatusTool({ query }, { passthroughEnabled: true })
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
    const tool = createGetReviewStatusTool({ query }, { passthroughEnabled: true });
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
    const result = await createGetReviewStatusTool({ query }, { passthroughEnabled: true })
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', phase: 'completed', check_run: null,
      operator_exemption: { publication_state: 'pending', merge_eligible: false, expected_lanes: 0, completed_lanes: 0 } });
  });

  it('does not report an exemption if reading its durable receipt fails', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => { throw new Error('database unavailable'); });
    const result = await createGetReviewStatusTool({ query }, { passthroughEnabled: true })
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: false, verdict: 'PENDING', phase: 'unknown', check_run: null });
    expect(value).not.toHaveProperty('operator_exemption');
  });

  it('falls through to ordinary review status when no active operator receipt exists', async () => {
    const normalRun = {
      run_id: 'run_1234567890abcdef1234567890abcdef', owner: candidate.owner, repo: candidate.repo,
      pr_number: candidate.pr_number, head_sha: candidate.head_sha, run_status: 'running', run_stage: 'review',
      attempt: 1, lease_owner: null, lease_expires_at: null, created_at: new Date('2026-10-05T12:00:00.000Z'),
      updated_at: new Date('2026-10-05T12:00:01.000Z'), attempt_id: 'attempt-1', check_id: null,
      desired_state: 'queued', decision: null, current_attempt: true,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [normalRun] })
      .mockResolvedValue({ rows: [] });
    const result = await createGetReviewStatusTool({ query }, { passthroughEnabled: true })
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ schema_version: 'ReviewStatus.v2', found: true, verdict: 'PENDING',
      phase: 'evaluating_personas', check_run: null, head_sha: candidate.head_sha, attempt_id: 'attempt-1' });
    expect(value).not.toHaveProperty('operator_exemption');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toContain('review_operator_passthrough_publications');
    expect(query.mock.calls[1][0]).toContain('FROM review_runs r');
  });
});
