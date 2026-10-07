import { describe, expect, it, vi } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import type { McpExecutionContext, ToolResult } from '../../src/mcp/server/mcpTypes';
import { PUBLIC_REVIEW_REPOSITORY, PUBLIC_REVIEW_REPOSITORY_ID } from '../../src/auth/repositoryReviewAuthority';
import { operatorPassthroughReadyForShip } from '../../src/review/operatorPassthrough';
import { AuthoritativeCandidateChangedError } from '../../src/review/authoritativePublishingResolver';
import { InternalGitHubDependencyUnavailableError, TransientAuthoritativeReadError } from '../../src/github/authoritativeReadFailure';

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
      repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
        owner: currentCandidate.owner, repo: currentCandidate.repo }],
      resolver: { readCurrentCandidate: vi.fn(async () => currentCandidate),
        resolve: vi.fn(async () => ({ current: currentCandidate,
          prepared: { policy: { effectivePolicyDigest: candidate.policy_digest } } })) },
    },
    resolveGitHubPullRequest: vi.fn(async () => ({ headSha: currentCandidate.headSha,
      baseSha: currentCandidate.baseSha, repositoryId: currentCandidate.repositoryId })),
    ...overrides,
  } as any;
}

function configuredStatusContext(owner = candidate.owner, repo = candidate.repo,
  overrides: Partial<McpExecutionContext> = {}): McpExecutionContext {
  return {
    caller: { authType: 'static_token', tokenDigest: 'configured1', isAdmin: false,
      allowedRepositories: new Set([`${owner}/${repo}`.toLowerCase()]), callerId: 'configured-status-caller' },
    identity: 'configured-status-caller',
    authenticatedByConfiguredAuthenticator: true,
    authorizedRepository: { owner, repo },
    ...overrides,
  };
}

function executeStatusWithContext(tool: ReturnType<typeof createGetReviewStatusTool>,
  args: Record<string, unknown>, context: McpExecutionContext): Promise<ToolResult> {
  return (tool.execute as unknown as
    (input: Record<string, unknown>, executionContext: McpExecutionContext) => Promise<ToolResult>)(args, context);
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

  it('returns unavailable current SHIP and destroys only the timed-out status client', async () => {
    vi.useFakeTimers();
    try {
      const lateRead = Promise.withResolvers<{ rows: any[] }>();
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT publication_id')) return lateRead.promise;
        return { rows: [] };
      });
      const connection = { query, release: vi.fn() };
      const db = { query: vi.fn(), connect: vi.fn(async () => connection) };
      const pending = createGetReviewStatusTool(db, statusOptions())
        .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
      await vi.advanceTimersByTimeAsync(1_501);
      const result = await pending;
      const value = JSON.parse((result.content[0] as { text: string }).text);
      expect(value).toMatchObject({ found: true, verdict: 'SHIP', head_sha: candidate.head_sha,
        operator_exemption: { candidate_state: 'current', publication_id: null, audit_digest: null,
          publication_state: 'unavailable', publication_receipt_available: null,
          review_check_id: null, gate_check_id: null, merge_eligible: false } });
      expect(db.connect).toHaveBeenCalledOnce();
      expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN READ ONLY']));
      expect(query.mock.calls.filter(([sql]) => sql.startsWith('SELECT publication_id'))).toHaveLength(1);
      expect(query.mock.calls.some(([sql]) => sql.startsWith('SET LOCAL statement_timeout = '))).toBe(true);
      expect(connection.release).toHaveBeenCalledWith(expect.any(Error));
      expect(query).not.toHaveBeenCalledWith('ROLLBACK');
      expect(query).not.toHaveBeenCalledWith('COMMIT');
      lateRead.resolve({ rows: [candidate] });
      await Promise.resolve();
      expect(value.operator_exemption).toMatchObject({ publication_id: null, publication_state: 'unavailable', merge_eligible: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a timed-out historical receipt unavailable instead of asserting stale-head SHIP', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT publication_id')) return new Promise<{ rows: any[] }>(() => {});
        return { rows: [] };
      });
      const connection = { query, release: vi.fn() };
      const db = { query: vi.fn(), connect: vi.fn(async () => connection) };
      const options = statusOptions({ authoritativePublishing: {
        expectedAppId: candidate.expected_app_id,
        repositoryIds: [currentCandidate.repositoryId],
        repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
          owner: currentCandidate.owner, repo: currentCandidate.repo }],
        resolver: { readCurrentCandidate: vi.fn(async () => currentCandidate),
          resolve: vi.fn(async () => { throw new AuthoritativeCandidateChangedError(); }) },
      } });
      const pending = createGetReviewStatusTool(db, options)
        .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number, head_sha: 'a'.repeat(40) });
      await vi.advanceTimersByTimeAsync(1_501);
      const result = await pending;
      const value = JSON.parse((result.content[0] as { text: string }).text);
      expect(value).toMatchObject({ found: false, verdict: 'PENDING', phase: 'unknown' });
      expect(value).not.toHaveProperty('operator_exemption');
      expect(connection.release).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['current-candidate lookup', 'policy resolution'] as const)(
    'returns zero-lane SHIP with unknown coordinates when internal GitHub %s permission is unavailable', async (stage) => {
    const query = vi.fn();
    const unavailable = new InternalGitHubDependencyUnavailableError();
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id,
      repositoryIds: [currentCandidate.repositoryId],
      repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
        owner: currentCandidate.owner, repo: currentCandidate.repo }],
      resolver: {
        readCurrentCandidate: vi.fn(stage === 'current-candidate lookup'
          ? async () => { throw unavailable; } : async () => currentCandidate),
        resolve: vi.fn(stage === 'policy resolution' ? async () => { throw unavailable; } : async () => ({
          current: currentCandidate, prepared: { policy: { effectivePolicyDigest: candidate.policy_digest } },
        })),
      },
    } });

    const result = await createGetReviewStatusTool({ query }, options)
      .execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number });
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ found: true, verdict: 'SHIP', head_sha: null, phase: 'completed',
      check_run: null, active_worker: null, active_projection: null,
      operator_exemption: { candidate_state: 'unavailable', publication_id: null, audit_digest: null,
        base_sha: null, policy_digest: null, expected_app_id: null, expected_lanes: 0,
        completed_lanes: 0, review_started: false, publication_state: 'unavailable',
        publication_receipt_available: null, review_check_id: null, gate_check_id: null, merge_eligible: false } });
    expect(query).not.toHaveBeenCalled();
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

  it('returns logical SHIP with no current authority coordinates when initial candidate authority is transiently unavailable', async () => {
    const readCurrentCandidate = vi.fn().mockRejectedValue(new TransientAuthoritativeReadError('network'));
    const query = vi.fn(async () => ({ rows: [] }));
    const resolver = { readCurrentCandidate, resolve: vi.fn() };
    const options = statusOptions({
      authoritativePublishing: { expectedAppId: candidate.expected_app_id,
        repositoryIds: [currentCandidate.repositoryId],
        repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
          owner: currentCandidate.owner, repo: currentCandidate.repo }], resolver },
    });
    const result = await createGetReviewStatusTool({ query }, options).execute({ owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
      head_sha: candidate.head_sha });
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ found: true, verdict: 'SHIP', attempt_id: null, head_sha: null,
      phase: 'completed', check_run: null, active_worker: null, active_projection: null,
      operator_exemption: { candidate_state: 'unavailable', publication_id: null, audit_digest: null,
        base_sha: null, policy_digest: null, expected_app_id: null, expected_lanes: 0,
        completed_lanes: 0, review_started: false, publication_state: 'unavailable',
        publication_receipt_available: null, review_check_id: null, gate_check_id: null, merge_eligible: false },
    });
    expect(readCurrentCandidate).toHaveBeenCalledOnce();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('does not fall open when the caller signal is canceled or local repository identity is missing', async () => {
    const readCurrentCandidate = vi.fn().mockRejectedValue(new Error('caller canceled'));
    const resolver = { readCurrentCandidate, resolve: vi.fn() };
    const query = vi.fn(async () => ({ rows: [] }));
    const withIdentity = statusOptions({ authoritativePublishing: { expectedAppId: candidate.expected_app_id,
      repositoryIds: [currentCandidate.repositoryId], repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
        owner: currentCandidate.owner, repo: currentCandidate.repo }], resolver } });
    await expect(createGetReviewStatusTool({ query }, withIdentity).execute({ owner: candidate.owner,
      repo: candidate.repo, pull_number: candidate.pr_number })).rejects.toThrow();

    const withoutIdentity = statusOptions({ authoritativePublishing: { expectedAppId: candidate.expected_app_id,
      repositoryIds: [currentCandidate.repositoryId], resolver } });
    await expect(createGetReviewStatusTool({ query }, withoutIdentity).execute({ owner: candidate.owner,
      repo: candidate.repo, pull_number: candidate.pr_number })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(withoutIdentity.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('returns only unavailable logical SHIP for an authenticated status read with no local name binding', async () => {
    const readCurrentCandidate = vi.fn();
    const resolve = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      resolver: { readCurrentCandidate, resolve },
    } });
    const result = await executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
      head_sha: candidate.head_sha,
    }, configuredStatusContext());
    const value = JSON.parse((result.content[0] as { text: string }).text);

    expect(value).toMatchObject({ schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP',
      attempt_id: null, head_sha: null, phase: 'completed', check_run: null,
      active_worker: null, active_projection: null,
      operator_exemption: { candidate_state: 'unavailable', publication_id: null, audit_digest: null,
        base_sha: null, policy_digest: null, expected_app_id: null, expected_lanes: 0,
        completed_lanes: 0, review_started: false, publication_state: 'unavailable',
        publication_receipt_available: null, review_check_id: null, gate_check_id: null, merge_eligible: false },
    });
    expect(readCurrentCandidate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['unconfigured authentication', { authenticatedByConfiguredAuthenticator: false }],
    ['missing authenticated caller', { caller: undefined }],
    ['missing RBAC context', { authorizedRepository: undefined }],
    ['mismatched RBAC repository', { authorizedRepository: { owner: candidate.owner, repo: 'other-repo' } }],
  ] as const)('does not return unavailable SHIP without %s when the local name binding is missing', async (_label, override) => {
    const readCurrentCandidate = vi.fn();
    const resolve = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      resolver: { readCurrentCandidate, resolve },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext(candidate.owner, candidate.repo, override))).rejects.toThrow();
    expect(readCurrentCandidate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed exact-name entry', [123], [
      { repositoryId: '123', owner: candidate.owner, repo: candidate.repo },
    ], undefined],
    ['ambiguous names', [123, 124], [
      { repositoryId: 123, owner: candidate.owner, repo: candidate.repo },
      { repositoryId: 124, owner: candidate.owner, repo: candidate.repo },
    ], undefined],
    ['a mapped identity outside the App allowlist', [123], [
      { repositoryId: 124, owner: candidate.owner, repo: candidate.repo },
    ], undefined],
    ['a conflicting App binding', [123], [
      { repositoryId: 123, owner: candidate.owner, repo: candidate.repo },
    ], () => 999],
  ] as const)('keeps a known %s as an authority error instead of unavailable SHIP', async (_label, repositoryIds,
    repositoryIdentities, expectedAppIdFor) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds, repositoryIdentities,
      ...(expectedAppIdFor ? { expectedAppIdFor } : {}),
      resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('does not treat an absent requested name as an empty identity map', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId, owner: 'otherorg', repo: 'other-repo' }],
      resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed primary App binding before the no-map status fallback', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: 4552718, repositoryIds: [currentCandidate.repositoryId],
      resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('returns unavailable SHIP for a private status read with mixed private and public App IDs', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const readCurrentCandidate = vi.fn();
    const resolve = vi.fn();
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId, PUBLIC_REVIEW_REPOSITORY_ID],
      resolver: { readCurrentCandidate, resolve },
    } });

    const result = await executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext());
    const value = JSON.parse((result.content[0] as { text: string }).text);
    expect(value).toMatchObject({ found: true, verdict: 'SHIP', head_sha: null,
      operator_exemption: { candidate_state: 'unavailable', expected_app_id: null,
        review_check_id: null, gate_check_id: null, merge_eligible: false } });
    expect(readCurrentCandidate).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('rejects a public-only numeric scope before private no-map status fallback', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [PUBLIC_REVIEW_REPOSITORY_ID],
      resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner: candidate.owner, repo: candidate.repo, pull_number: candidate.pr_number,
    }, configuredStatusContext())).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('keeps a missing dedicated public App binding as an authority error', async () => {
    const [owner, repo] = PUBLIC_REVIEW_REPOSITORY.split('/');
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      repositoryIdentities: [], resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });

    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), {
      owner, repo, pull_number: candidate.pr_number,
    }, configuredStatusContext(owner, repo))).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
  });

  it('rejects ambiguous paused repository names before any caller-name GitHub lookup', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [123, 124],
      repositoryIdentities: [
        { repositoryId: 123, owner: candidate.owner, repo: candidate.repo },
        { repositoryId: 124, owner: candidate.owner, repo: candidate.repo },
      ],
      resolver: { readCurrentCandidate: vi.fn(), resolve: vi.fn() },
    } });
    await expect(executeStatusWithContext(createGetReviewStatusTool({ query }, options), { owner: candidate.owner,
      repo: candidate.repo, pull_number: candidate.pr_number }, configuredStatusContext())).rejects.toThrow();
    expect(options.resolveGitHubPullRequest).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('reports a closed candidate published historically without current merge eligibility', async () => {
    const query = vi.fn(async () => ({ rows: [candidate] }));
    const options = statusOptions({ authoritativePublishing: {
      expectedAppId: candidate.expected_app_id, repositoryIds: [currentCandidate.repositoryId],
      repositoryIdentities: [{ repositoryId: currentCandidate.repositoryId,
        owner: currentCandidate.owner, repo: currentCandidate.repo }],
      resolver: { readCurrentCandidate: vi.fn(async () => currentCandidate),
        resolve: vi.fn(async () => { throw new AuthoritativeCandidateChangedError(); }) },
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
