import { describe, expect, it, vi } from 'vitest';
import { AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceConfig';
import { createMergeGroupGate, MergeGroupGateInProgressError } from '../../src/review/mergeGroupGate';

const GROUP_HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PR_HEAD = 'c'.repeat(40);
const config = {
  secret: 'x'.repeat(64), admissionEnabled: true,
  repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']),
};
const officialApp = { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' };

function payload() {
  return {
    action: 'checks_requested', installation: { id: 123 },
    repository: {
      id: 614653796, name: 'dashboard', full_name: 'calltelemetry/dashboard',
      owner: { id: 57884877, login: 'calltelemetry' },
    },
    merge_group: {
      head_sha: GROUP_HEAD, base_sha: BASE,
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef0',
      base_ref: 'refs/heads/main',
    },
  };
}

function queue(head = PR_HEAD, trailingEntries: any[] = []) {
  const nodes = [{
    position: 1, state: 'AWAITING_CHECKS', baseCommit: { oid: BASE }, headCommit: { oid: GROUP_HEAD },
    pullRequest: {
      number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: head,
      repository: { nameWithOwner: 'calltelemetry/dashboard' },
    },
  }, ...trailingEntries];
  return { data: { repository: { mergeQueue: {
    id: 'MQ_1', entries: { totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false } },
  } } } };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function repository(stored?: { checkId: number; conclusion: 'success' | 'failure' }) {
  return {
    claim: vi.fn(async () => stored
      ? { status: 'terminal' as const, result: stored }
      : { status: 'acquired' as const }),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

describe('native merge-group Review Yeti gate', () => {
  it('publishes exactly one successful official App check after two stable exact-head queue reads', async () => {
    let graphqlReads = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/commits/${GROUP_HEAD}/check-runs?filter=all&per_page=100`)) {
        return response({ total_count: 0, check_runs: [] });
      }
      if (url.endsWith('/check-runs') && init?.method === 'POST') {
        return response({ id: 9001, status: 'in_progress' });
      }
      if (url === 'https://api.github.com/graphql') {
        graphqlReads += 1;
        return response(queue());
      }
      if (url.endsWith(`/commits/${PR_HEAD}/check-runs?filter=all&per_page=100`)) {
        return response({ total_count: 1, check_runs: [{
          id: 8001, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
        }] });
      }
      if (url.endsWith('/check-runs/9001') && init?.method === 'PATCH') return response({ id: 9001 });
      return response({ error: 'unexpected request' }, 500);
    }) as typeof fetch;
    const store = repository();
    const gate = createMergeGroupGate({
      config, repository: store as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9001, conclusion: 'success', constituents: 1 });
    expect(graphqlReads).toBe(2);
    const creates = (fetchImplementation as any).mock.calls.filter(([, init]: [unknown, RequestInit]) => init?.method === 'POST'
      && String((init as RequestInit).body).includes('review-yeti-merge-group:614653796'));
    expect(creates).toHaveLength(1);
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9001') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body))).toEqual(expect.objectContaining({ status: 'completed', conclusion: 'success' }));
  });

  it('qualifies only constituents at or ahead of the current queue entry', async () => {
    const behindHead = 'd'.repeat(40);
    const trailing = [{
      position: 2, state: 'AWAITING_CHECKS', baseCommit: { oid: BASE }, headCommit: { oid: 'e'.repeat(40) },
      pullRequest: { number: 43, state: 'OPEN', baseRefName: 'main', headRefOid: behindHead,
        repository: { nameWithOwner: 'calltelemetry/dashboard' } },
    }];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return response({ id: 9013 });
      if (url === 'https://api.github.com/graphql') return response(queue(PR_HEAD, trailing));
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8013, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9013') && init?.method === 'PATCH') return response({ id: 9013 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9013, conclusion: 'success', constituents: 1 });
    expect((fetchImplementation as any).mock.calls.some(([url]: [unknown]) => String(url).includes(behindHead))).toBe(false);
  });

  it('completes the created check as failure when queue evidence becomes unavailable', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return response({ id: 9002 });
      if (url === 'https://api.github.com/graphql') return response({ error: 'unavailable' }, 503);
      if (url.endsWith('/check-runs/9002') && init?.method === 'PATCH') return response({ id: 9002 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9002, conclusion: 'failure', constituents: 0 });
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9002') && init?.method === 'PATCH');
    const body = JSON.parse(String(completion[1].body));
    expect(body.conclusion).toBe('failure');
    expect(body.output.summary).toBe('- merge-group evidence could not be verified');
    expect(JSON.stringify(body)).not.toContain('unavailable');
  });

  it.each([
    ['pending', PR_HEAD, 'in_progress', null, 'latest exact-head Review Yeti check is not successful', officialApp],
    ['failed', PR_HEAD, 'completed', 'failure', 'latest exact-head Review Yeti check is not successful', officialApp],
    ['stale', 'd'.repeat(40), 'completed', 'success', 'contains malformed or stale Review Yeti evidence', officialApp],
    ['foreign App', PR_HEAD, 'completed', 'success', 'has no Review Yeti check from the official App',
      { id: AUTHORITATIVE_REVIEW_APP_ID + 1, slug: 'ct-review-bot' }],
  ])('fails the synthetic check for %s constituent evidence',
    async (_label, observedHead, status, conclusion, reason, app) => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return response({ id: 9004 });
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8002, name: 'Review Yeti', head_sha: observedHead, status, conclusion,
        app,
      }] });
      if (url.endsWith('/check-runs/9004') && init?.method === 'PATCH') return response({ id: 9004 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9004, conclusion: 'failure', constituents: 1 });
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9004') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary).toContain(`PR #42: ${reason}`);
    });

  it.each([
    ['later success', [
      { id: 10, status: 'completed', conclusion: 'failure' },
      { id: 11, status: 'completed', conclusion: 'success' },
    ], 'success'],
    ['later failure', [
      { id: 20, status: 'completed', conclusion: 'success' },
      { id: 21, status: 'completed', conclusion: 'failure' },
    ], 'failure'],
  ])('uses the %s official check when multiple exact-head runs exist', async (_label, runs, expected) => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return response({ id: 9014 });
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({
        total_count: runs.length,
        check_runs: runs.map((run) => ({ ...run, name: 'Review Yeti', head_sha: PR_HEAD, app: officialApp })),
      });
      if (url.endsWith('/check-runs/9014') && init?.method === 'PATCH') return response({ id: 9014 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9014, conclusion: expected, constituents: 1 });
  });

  it('fails when the merge queue changes between qualification reads', async () => {
    let graphqlReads = 0;
    const changedHead = 'e'.repeat(40);
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return response({ id: 9005 });
      if (url === 'https://api.github.com/graphql') {
        graphqlReads += 1;
        return response(queue(graphqlReads === 1 ? PR_HEAD : changedHead));
      }
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8003, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9005') && init?.method === 'PATCH') return response({ id: 9005 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9005, conclusion: 'failure', constituents: 1 });
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9005') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary)
      .toContain('merge queue changed during exact-head qualification');
  });

  it('reuses a transactionally stored result without minting a token or touching GitHub', async () => {
    const tokenFor = vi.fn(async () => 'ghs_test');
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository({ checkId: 9003, conclusion: 'success' }) as any,
      tokenFor, fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9003, conclusion: 'success', constituents: 0 });
    expect(tokenFor).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a duplicate delivery without holding a connection or touching GitHub', async () => {
    const tokenFor = vi.fn(async () => 'ghs_test');
    const store = {
      claim: vi.fn(async () => ({ status: 'busy' as const })), complete: vi.fn(), release: vi.fn(),
    };
    const gate = createMergeGroupGate({ config, repository: store, tokenFor });
    await expect(gate(payload())).rejects.toBeInstanceOf(MergeGroupGateInProgressError);
    expect(tokenFor).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });

  it('reconciles a matching terminal GitHub check without creating or re-verifying it', async () => {
    const stableId = `review-yeti-merge-group:614653796:${GROUP_HEAD}`;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({
        total_count: 1, check_runs: [{ id: 9010, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'completed', conclusion: 'success',
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9010, conclusion: 'success', constituents: 0 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('resumes a matching in-progress GitHub check without creating a duplicate', async () => {
    const stableId = `review-yeti-merge-group:614653796:${GROUP_HEAD}`;
    let graphqlReads = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({
        total_count: 1, check_runs: [{ id: 9011, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'in_progress', conclusion: null,
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      });
      if (url === 'https://api.github.com/graphql') { graphqlReads += 1; return response(queue()); }
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8011, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9011') && init?.method === 'PATCH') return response({ id: 9011 });
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9011, conclusion: 'success', constituents: 1 });
    expect(graphqlReads).toBe(2);
    expect((fetchImplementation as any).mock.calls.some(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toBe(false);
  });

  it('propagates a terminal PATCH failure and resumes the same in-progress check on retry', async () => {
    const stableId = `review-yeti-merge-group:614653796:${GROUP_HEAD}`;
    let completionAttempts = 0;
    let created = false;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response(created ? {
        total_count: 1, check_runs: [{ id: 9012, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'in_progress', conclusion: null,
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      } : { total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') {
        created = true;
        return response({ id: 9012, status: 'in_progress' });
      }
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8012, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9012') && init?.method === 'PATCH') {
        completionAttempts += 1;
        return completionAttempts === 1 ? response({ error: 'unavailable' }, 503) : response({ id: 9012 });
      }
      return response({}, 500);
    }) as typeof fetch;
    const store = repository();
    const gate = createMergeGroupGate({
      config, repository: store as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).rejects.toThrow('GitHub JSON request failed with HTTP 503');
    await expect(gate(payload())).resolves.toEqual({ checkId: 9012, conclusion: 'success', constituents: 1 });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(completionAttempts).toBe(2);
    expect((fetchImplementation as any).mock.calls.filter(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects an unenrolled or malformed merge-group identity before any side effect', async () => {
    const store = repository();
    const tokenFor = vi.fn(async () => 'ghs_test');
    const gate = createMergeGroupGate({ config, repository: store as any, tokenFor });
    await expect(gate({ ...payload(), merge_group: { ...payload().merge_group, head_ref: 'refs/heads/main' } }))
      .rejects.toThrow('GitHub webhook repository identity is not enrolled');
    expect(store.claim).not.toHaveBeenCalled();
    expect(tokenFor).not.toHaveBeenCalled();
  });
});
