import { describe, expect, it, vi } from 'vitest';
import { createMergeGroupMaintenanceQueue } from '../../src/review/mergeGroupMaintenanceQueue';
import type { OperatorMaintenanceIdentity } from '../../src/review/operatorMaintenanceContracts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PR_HEAD = 'c'.repeat(40);
const PREVIOUS_HEAD = 'd'.repeat(40);
const config = { secret: 'x'.repeat(64), admissionEnabled: true, passthroughEnabled: true,
  repositoryIds: new Set(['610001']), ownerIds: new Set(['710001']) };
const identity: OperatorMaintenanceIdentity = {
  repositoryId: 610001, owner: 'review-yeti-ai', repo: 'sample', headSha: HEAD, baseSha: BASE,
  subject: { kind: 'merge_group', headRef: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef0', baseRef: 'refs/heads/main' },
};

function queue(currentHead = HEAD) {
  const nodes = [
    { position: 1, state: 'QUEUED', baseCommit: { oid: BASE }, headCommit: { oid: PREVIOUS_HEAD }, pullRequest: {
      number: 41, state: 'OPEN', baseRefName: 'main', headRefOid: PREVIOUS_HEAD,
      repository: { nameWithOwner: 'review-yeti-ai/sample' },
    } },
    { position: 2, state: 'AWAITING_CHECKS', baseCommit: { oid: BASE }, headCommit: { oid: currentHead }, pullRequest: {
      number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: PR_HEAD,
      repository: { nameWithOwner: 'review-yeti-ai/sample' },
    } },
  ];
  return { data: { repository: { mergeQueue: { id: 'queue-live', entries: {
    totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false },
  } } } } };
}

function response(body: unknown) { return new Response(JSON.stringify(body), { status: 200 }); }

describe('merge-group maintenance queue revalidation', () => {
  it('selects a real policy PR from a complete multi-entry current queue', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/repos/review-yeti-ai/sample')) return response({ id: 610001, name: 'sample',
        full_name: 'review-yeti-ai/sample', owner: { id: 710001, login: 'review-yeti-ai' } });
      if (url.endsWith('/graphql')) return response(queue());
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const verifier = createMergeGroupMaintenanceQueue({ config, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation });

    await expect(verifier.currentPolicyPullRequest(identity)).resolves.toEqual({ repositoryId: 610001,
      owner: 'review-yeti-ai', repo: 'sample', prNumber: 42, headSha: PR_HEAD });
    await expect(verifier.verifyCurrent(identity, { repositoryId: 610001, owner: 'review-yeti-ai',
      repo: 'sample', prNumber: 42, headSha: PR_HEAD })).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(6);
  });

  it('rejects a stale group head or policy PR moved from the current queue before publication', async () => {
    let groupHead = HEAD;
    let policyHead = PR_HEAD;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/repos/review-yeti-ai/sample')) return response({ id: 610001, name: 'sample',
        full_name: 'review-yeti-ai/sample', owner: { id: 710001, login: 'review-yeti-ai' } });
      if (url.endsWith('/graphql')) {
        const body = queue(groupHead);
        body.data.repository.mergeQueue.entries.nodes[1].pullRequest.headRefOid = policyHead;
        return response(body);
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const verifier = createMergeGroupMaintenanceQueue({ config, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation });
    const policy = { repositoryId: 610001, owner: 'review-yeti-ai', repo: 'sample', prNumber: 42,
      headSha: PR_HEAD, baseSha: BASE };

    groupHead = 'e'.repeat(40);
    await expect(verifier.verifyCurrent(identity, policy)).rejects.toThrow(/changed|no longer matches/u);
    groupHead = HEAD;
    policyHead = 'f'.repeat(40);
    await expect(verifier.verifyCurrent(identity, policy)).rejects.toThrow(/changed|no longer matches/u);
  });
});
