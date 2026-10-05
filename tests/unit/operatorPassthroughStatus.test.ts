import { describe, expect, it, vi } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';

const candidate = {
  publication_id: 'a'.repeat(64), audit_digest: 'b'.repeat(64),
  owner: 'exampleorg', repo: 'example-repo', pr_number: 42,
  head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40), policy_digest: 'e'.repeat(64),
  expected_app_id: 15368, review_check_id: 7001, review_creation_state: 'bound',
  gate_check_id: 7002, gate_creation_state: 'bound', retirement_requested_at: null, retired_at: null,
};

describe('get_review_status operator-passthrough projection', () => {
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
});
