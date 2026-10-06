import { afterEach, describe, expect, it, vi } from 'vitest';

const CENTRAL = 'example-org/central-review';

async function loadModules() {
  vi.resetModules();
  const identity = await import('../../src/review/reviewCheckIdentity');
  const rbac = await import('../../src/mcp/server/mcpRbac');
  return { identity, rbac };
}

function centralClaims(repository: string) {
  return {
    workflow_ref: `${repository}/.github/workflows/repository-dispatch.yml@refs/heads/main`,
    job_workflow_ref: `${repository}/.github/workflows/review-yeti.yml@refs/heads/v1`,
  };
}

describe('central review identity is deployment configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fails closed when REVIEW_YETI_CENTRAL_REPOSITORY is unset or malformed', async () => {
    for (const value of ['', '   ', 'no-slash', 'a/b/c', '/repo', 'owner/']) {
      vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', value);
      const { identity, rbac } = await loadModules();
      expect(identity.CENTRAL_REVIEW_CONFIGURED).toBe(false);

      // Even claims that match the (degenerate) derived refs are denied.
      const claims = centralClaims(identity.CENTRAL_REVIEW_REPOSITORY);
      expect(identity.isCentralReviewDispatchIdentity({ workflowRef: claims.workflow_ref }, claims)).toBe(false);

      const caller = {
        isAdmin: false,
        claims: { repository: identity.CENTRAL_REVIEW_REPOSITORY, event_name: 'repository_dispatch' },
      } as never;
      // Target the derived owner itself, so only the CENTRAL_REVIEW_CONFIGURED guard can deny.
      const targetOwner = identity.CENTRAL_REVIEW_OWNER || 'example-org';
      expect(rbac.canAccessRepository(caller, targetOwner, 'some-repo')).toBe(false);
    }
  });

  it('admits exactly the configured central workflow identity', async () => {
    vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', CENTRAL);
    const { identity, rbac } = await loadModules();
    expect(identity.CENTRAL_REVIEW_CONFIGURED).toBe(true);
    expect(identity.CENTRAL_REVIEW_OWNER).toBe('example-org');

    const claims = centralClaims(CENTRAL);
    expect(identity.isCentralReviewDispatchIdentity({ workflowRef: claims.workflow_ref }, claims)).toBe(true);
    // A different repository's workflow, or a mismatched caller ref, is denied.
    const other = centralClaims('example-org/other-repo');
    expect(identity.isCentralReviewDispatchIdentity({ workflowRef: other.workflow_ref }, other)).toBe(false);
    expect(identity.isCentralReviewDispatchIdentity({ workflowRef: 'x' }, claims)).toBe(false);

    const caller = { isAdmin: false, claims: { repository: CENTRAL, event_name: 'repository_dispatch' } } as never;
    expect(rbac.canAccessRepository(caller, 'example-org', 'some-repo')).toBe(true);
    expect(rbac.canAccessRepository(caller, 'unrelated-org', 'some-repo')).toBe(false);
  });

  it('admits a central repository_dispatch only when the central repository is configured', async () => {
    const sha = 'a'.repeat(40);
    const request = {
      version: 'ActionDispatch.v1',
      deliveryId: `actions:777:1:11:5:${sha}`,
      repositoryId: 11,
      owner: 'example-org',
      repo: 'target',
      prNumber: 5,
      headSha: sha,
      baseSha: 'b'.repeat(40),
      actionSha: 'c'.repeat(40),
      publishMode: 'app-gate',
      requestedAt: '2026-10-02T00:00:00.000Z',
      caller: { runId: '777', runAttempt: 1, eventName: 'repository_dispatch' },
    };
    const claims = {
      repository: CENTRAL,
      repository_id: '22',
      run_id: '777',
      run_attempt: '1',
      event_name: 'repository_dispatch',
    };

    vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', CENTRAL);
    vi.resetModules();
    const configured = await import('../../src/review/actionDispatch');
    expect(configured.assertActionDispatchMatchesClaims(request as never, claims as never)).toBe('central');

    vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', '');
    vi.resetModules();
    const unconfigured = await import('../../src/review/actionDispatch');
    expect(() => unconfigured.assertActionDispatchMatchesClaims(request as never, claims as never)).toThrow(
      /does not match the verified GitHub OIDC claims/u,
    );
  });

  it('treats the central owner case-insensitively, as GitHub does', async () => {
    const sha = 'a'.repeat(40);
    const claims = { repository: CENTRAL, repository_id: '22', run_id: '777', run_attempt: '1', event_name: 'repository_dispatch' };
    const request = (owner: string) => ({
      version: 'ActionDispatch.v1', deliveryId: `actions:777:1:11:5:${sha}`, repositoryId: 11, owner, repo: 'target',
      prNumber: 5, headSha: sha, baseSha: 'b'.repeat(40), actionSha: 'c'.repeat(40), publishMode: 'app-gate',
      requestedAt: '2026-10-02T00:00:00.000Z', caller: { runId: '777', runAttempt: 1, eventName: 'repository_dispatch' },
    });
    vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', CENTRAL);
    vi.resetModules();
    const mod = await import('../../src/review/actionDispatch');
    for (const owner of ['example-org', 'Example-Org', 'EXAMPLE-ORG']) {
      expect(mod.assertActionDispatchMatchesClaims(request(owner) as never, claims as never)).toBe('central');
    }
    expect(() => mod.assertActionDispatchMatchesClaims(request('other-org') as never, claims as never)).toThrow();
  });
});
