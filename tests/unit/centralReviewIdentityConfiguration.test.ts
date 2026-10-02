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
      expect(rbac.canAccessRepository(caller, 'example-org', 'some-repo')).toBe(false);
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
});
