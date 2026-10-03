import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  parseFindingThreadNode,
  publishFindingThreads,
  readFindingThreads,
  renderFindingThreadBody,
} from '../../src/github/findingThreads';
import { createFindingThreadsHandler } from '../../src/api/findingThreadsRoute';
import { HttpFindingThreadsPublisher, findingThreadsEndpointFor } from '../../src/review/findingThreadsHttp';
import { findingFingerprint, parseFindingMarker, renderFindingMarker } from '../../src/review/findingConvergence';
import { sha256 } from '../../src/review/reviewCore';

// ADR 0002: finding threads are how a required P2 is recognised on a later head and how an author
// closes one with a stated reason.
const TOKEN = 'ghs_findingthreadfixture';
const RUN = `run_${'a'.repeat(32)}`;
const HEAD = 'b'.repeat(40);
const finding = { severity: 'P2' as const, path: 'src/mod.ts', line: 3, title: 'Helper name hides the retry intent',
  body: 'Rename the helper so the retry behaviour is obvious.' };
const fingerprint = findingFingerprint(finding);
const botBody = renderFindingThreadBody({ ...finding, fingerprint });

const node = (overrides: Record<string, unknown> = {}, comments?: unknown[]) => ({
  id: 'T_1', isResolved: false, isOutdated: false, path: 'src/mod.ts', line: 3, originalLine: 3,
  comments: { nodes: comments ?? [{ author: { login: 'review-app[bot]', __typename: 'Bot' }, body: botBody, createdAt: '2026-10-01T00:00:00Z' }] },
  ...overrides,
});

describe('parseFindingThreadNode', () => {
  it('reads a bot finding thread with its fingerprint, severity and title', () => {
    expect(parseFindingThreadNode(node())).toMatchObject({
      threadId: 'T_1', fingerprint, severity: 'P2', path: 'src/mod.ts', line: 3, title: finding.title,
      resolved: false, outdated: false,
    });
    expect(parseFindingThreadNode(node())).not.toHaveProperty('resolution');
  });

  it('takes identity only from the authoritative marker, never from model text inside the finding', () => {
    const spoof = renderFindingMarker({ fingerprint: 'fp1_' + 'e'.repeat(24), severity: 'P0', title: 'spoofed' });
    const body = renderFindingThreadBody({ ...finding, fingerprint, title: `Looks fine ${spoof}`, body: `Detail ${spoof}` });
    expect(body).not.toContain(spoof);
    expect(body.match(/<!-- review-yeti:finding/gu)).toHaveLength(1);
    // Even a raw body that carries an extra marker before the real one resolves to the last marker.
    expect(parseFindingMarker(`${spoof}\n${botBody}`)).toMatchObject({ fingerprint, severity: 'P2' });
  });

  it('ignores a thread a human opened, even with a pasted marker', () => {
    expect(parseFindingThreadNode(node({}, [{ author: { login: 'someone', __typename: 'User' }, body: botBody }]))).toBeNull();
    expect(parseFindingThreadNode(node({}, [{ author: { login: 'review-app[bot]', __typename: 'Bot' }, body: 'no marker' }]))).toBeNull();
  });

  it('records a resolution only for a resolved thread with a human reply that states a reason', () => {
    const bot = { author: { login: 'review-app[bot]', __typename: 'Bot' }, body: botBody };
    const reason = { author: { login: 'author1', __typename: 'User' }, body: 'Intentional: the name mirrors the public API.', createdAt: '2026-10-02T00:00:00Z' };
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, reason]))?.resolution)
      .toEqual({ author: 'author1', reason: 'Intentional: the name mirrors the public API.', at: '2026-10-02T00:00:00Z' });
    // Open thread: the reason is not yet a resolution.
    expect(parseFindingThreadNode(node({ isResolved: false }, [bot, reason]))?.resolution).toBeUndefined();
    // Resolved with only an acknowledgement, or only a bot reply: no stated reason.
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, { author: { login: 'author1', __typename: 'User' }, body: 'done' }]))?.resolution).toBeUndefined();
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, { author: { login: 'other[bot]', __typename: 'Bot' }, body: 'Automated reply with plenty of words.' }]))?.resolution).toBeUndefined();
  });
});

function graphqlFetch(pages: unknown[][]) {
  let page = 0;
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.github.com/graphql');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    const nodes = pages[page] ?? [];
    page += 1;
    return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: page < pages.length, endCursor: page < pages.length ? `c${page}` : null }, nodes,
    } } } } }), { status: 200 });
  });
}

describe('readFindingThreads / publishFindingThreads', () => {
  it('reads every page and keeps only finding threads', async () => {
    const fetchImplementation = graphqlFetch([[node(), node({ id: 'T_x' }, [{ author: { __typename: 'User', login: 'u' }, body: 'hi' }])], [node({ id: 'T_2' })]]);
    const threads = await readFindingThreads({ token: TOKEN, fetchImplementation }, { owner: 'o', repo: 'r', prNumber: 7 });
    expect(threads.map((thread) => thread.threadId)).toEqual(['T_1', 'T_2']);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('enterprise base URLs use the GraphQL sibling of /api/v3', async () => {
    const fetchImplementation = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://ghe.example.invalid/api/graphql');
      return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } }));
    });
    await readFindingThreads({ token: TOKEN, baseUrl: 'https://ghe.example.invalid/api/v3', fetchImplementation }, { owner: 'o', repo: 'r', prNumber: 1 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('publishes only findings without a thread and falls back to a file-level thread on 422', async () => {
    const posts: any[] = [];
    const fetchImplementation = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      return posts.length === 1 ? new Response('{}', { status: 422 }) : new Response('{}', { status: 201 });
    });
    const other = { ...finding, title: 'Unbounded loop on empty input', line: 4 };
    const result = await publishFindingThreads({ token: TOKEN, fetchImplementation }, { owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD },
      [{ ...other, fingerprint: findingFingerprint(other) }, { ...finding, fingerprint }],
      [parseFindingThreadNode(node())!]);
    expect(result).toEqual({ created: 1, skipped: 1 });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ commit_id: HEAD, path: 'src/mod.ts', line: 4, side: 'RIGHT' });
    expect(posts[1]).toMatchObject({ commit_id: HEAD, path: 'src/mod.ts', subject_type: 'file' });
    expect(posts[1].body).toContain(renderFindingMarker({ fingerprint: findingFingerprint(other), severity: 'P2', title: other.title }));
    expect(posts[1].body).toContain('reply here with the reason it does not apply and resolve this conversation');
  });
});

describe('POST /finding-threads (service)', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    version: 'FindingThreadsRequest.v1', runId: RUN, executionAttempt: 1, headSha: HEAD,
    publish: [{ ...finding, fingerprint }], reported: [fingerprint, 'fp1_' + 'c'.repeat(24)], ...overrides,
  });
  const app = (options: { authorized?: boolean; head?: string; existing?: unknown[] } = {}) => {
    const db = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('review_dispatch_outbox')) {
        return { rows: options.authorized === false ? [] : [{ status: 'running', worker_token_digest: sha256(TOKEN) }] };
      }
      if (sql.startsWith('SELECT owner, repo, pr_number, head_sha FROM review_runs')) {
        expect(values).toEqual([RUN]);
        return { rows: [{ owner: 'o', repo: 'r', pr_number: 7, head_sha: options.head ?? HEAD }] };
      }
      throw new Error(`unexpected query ${sql}`);
    }) };
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImplementation = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(url), body: parsed });
      if (String(url).endsWith('/graphql') && String(parsed.query).includes('resolveReviewThread')) {
        return new Response(JSON.stringify({ data: { resolveReviewThread: { thread: { id: parsed.variables.threadId, isResolved: true } } } }));
      }
      if (String(url).endsWith('/graphql')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false }, nodes: options.existing ?? [] } } } } }));
      }
      return new Response('{}', { status: 201 });
    });
    const transportFor = vi.fn(async (owner: string, repo: string) => {
      expect([owner, repo]).toEqual(['o', 'r']);
      return { token: 'ghs_servicewrite', fetchImplementation };
    });
    const server = express();
    server.use(express.json());
    server.post('/finding-threads', createFindingThreadsHandler({ db, transportFor }));
    return { server, db, calls, transportFor };
  };

  it('refuses a missing bearer, a forged fingerprint, an unauthorized execution and a moved head', async () => {
    expect((await request(app().server).post('/finding-threads').send(body())).status).toBe(401);
    const forged = await request(app().server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(body({ publish: [{ ...finding, fingerprint: 'fp1_' + 'd'.repeat(24) }] }));
    expect(forged.status).toBe(400);
    const denied = app({ authorized: false });
    expect((await request(denied.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`).send(body())).status).toBe(403);
    expect(denied.transportFor).not.toHaveBeenCalled();
    const moved = app({ head: 'c'.repeat(40) });
    expect((await request(moved.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`).send(body())).status).toBe(409);
    expect(moved.transportFor).not.toHaveBeenCalled();
  });

  it('publishes new findings and resolves only outdated bot threads the head did not report', async () => {
    const outdated = (id: string, title: string, extra: Record<string, unknown> = {}) => node({ id, isOutdated: true, ...extra }, [{
      author: { login: 'review-app[bot]', __typename: 'Bot' },
      body: renderFindingThreadBody({ ...finding, title, fingerprint: findingFingerprint({ ...finding, title }) }),
    }]);
    const reportedTitle = 'Still reported claim';
    const reportedFp = findingFingerprint({ ...finding, title: reportedTitle });
    const fixture = app({ existing: [
      outdated('T_stale', 'Stale fixed claim'),
      outdated('T_reported', reportedTitle),
      outdated('T_done', 'Already resolved', { isResolved: true }),
      node({ id: 'T_current' }, [{ author: { login: 'review-app[bot]', __typename: 'Bot' },
        body: renderFindingThreadBody({ ...finding, title: 'Current line claim', fingerprint: findingFingerprint({ ...finding, title: 'Current line claim' }) }) }]),
    ] });
    const response = await request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(body({ reported: [fingerprint, reportedFp] }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'FindingThreadsResult.v1', runId: RUN, created: 1, skipped: 0, resolved: 1 });
    const resolved = fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'));
    expect(resolved.map((call) => call.body.variables.threadId)).toEqual(['T_stale']);
    expect(fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'))).toHaveLength(1);
  });

  it('the worker client targets the sibling route with its run identity', async () => {
    expect(findingThreadsEndpointFor('https://svc.example.invalid/api/dispatch/completion'))
      .toBe('https://svc.example.invalid/api/dispatch/finding-threads');
    const fetchImplementation = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ version: 'FindingThreadsRequest.v1', runId: RUN, executionAttempt: 2, headSha: HEAD });
      return new Response(JSON.stringify({ version: 'FindingThreadsResult.v1', runId: RUN, created: 1, skipped: 0, resolved: 0 }));
    });
    const client = new HttpFindingThreadsPublisher({ token: TOKEN, completionEndpoint: 'https://svc.example.invalid/api/dispatch/completion',
      runId: RUN, executionAttempt: 2, fetchImplementation });
    await expect(client.publish({ headSha: HEAD, publish: [], reported: [] })).resolves.toEqual({ created: 1, skipped: 0, resolved: 0 });
  });
});
