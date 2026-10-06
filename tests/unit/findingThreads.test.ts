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
import { findingFingerprint, isResolutionSatisfiable, parseFindingMarker, renderFindingMarker } from '../../src/review/findingConvergence';
import { computeArbitration, sha256 } from '../../src/review/reviewCore';
import { createReviewDecisionV2, REVIEW_SEVERITY_POLICY_V2 } from '../../src/review/reviewDecision';
import { deriveCanonicalWorkerReviewEvidence } from '../../src/review/workerReviewCompletion';
import { findingThreadsRequestSchema } from '../../src/review/findingThreadsContract';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { savePreparedPublishingPolicy } from '../../src/persistence/preparedReviewRepository';
import { groundedFixtureReceipt } from '../support/groundedReviewFixture';

// ADR 0002: finding threads are how a required P2 is recognised on a later head and how an author
// closes one with a stated reason.
const TOKEN = 'ghs_findingthreadfixture';
const RUN = `run_${'a'.repeat(32)}`;
const HEAD = 'b'.repeat(40);
const finding = { severity: 'P2' as const, path: 'src/mod.ts', line: 3, title: 'Helper name hides the retry intent',
  body: 'Rename the helper so the retry behaviour is obvious.' };
const fingerprint = findingFingerprint(finding);
const botBody = renderFindingThreadBody({ ...finding, fingerprint });
const APP = 'review-app[bot]';

const v2Decision = createReviewDecisionV2({
  schemaVersion: 'review-yeti-decision.v2',
  policyVersion: REVIEW_SEVERITY_POLICY_V2,
  policyDigest: 'd'.repeat(64),
  coverageComplete: true,
  quorumSatisfied: true,
  infrastructureFailure: false,
  expectedLanes: 2,
  completedLanes: 2,
  counts: { p0Count: 0, p1Count: 0, p2Count: 1, p3Count: 0, nitCount: 0 },
});

describe('FindingThreadsRequest.v2', () => {
  it('binds advisory migration to the exact trusted review coordinates and decision receipt', () => {
    const parsed = findingThreadsRequestSchema.safeParse({
      version: 'FindingThreadsRequest.v2', runId: RUN, executionAttempt: 2, repositoryId: 123,
      owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD, baseSha: 'c'.repeat(40),
      policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), reviewDecision: v2Decision,
    });
    expect(parsed.success).toBe(true);
    expect(findingThreadsRequestSchema.safeParse({
      version: 'FindingThreadsRequest.v2', runId: RUN, executionAttempt: 2, repositoryId: 123,
      owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD, baseSha: 'c'.repeat(40),
      policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), reviewDecision: v2Decision,
      publish: [], reported: [],
    }).success).toBe(false);
  });
});

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
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, reason]), APP)?.resolution)
      .toEqual({ author: 'author1', reason: 'Intentional: the name mirrors the public API.', at: '2026-10-02T00:00:00Z' });
    // Open thread: the reason is not yet a resolution.
    expect(parseFindingThreadNode(node({ isResolved: false }, [bot, reason]), APP)?.resolution).toBeUndefined();
    // Resolved with only an acknowledgement, or only a bot reply: no stated reason.
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, { author: { login: 'author1', __typename: 'User' }, body: 'done' }]), APP)?.resolution).toBeUndefined();
    expect(parseFindingThreadNode(node({ isResolved: true }, [bot, { author: { login: 'other[bot]', __typename: 'Bot' }, body: 'Automated reply with plenty of words.' }]), APP)?.resolution).toBeUndefined();
  });

  it('trusts only the review App as the thread author for resolutions', () => {
    const reason = { author: { login: 'author1', __typename: 'User' }, body: 'Intentional: the name mirrors the public API.' };
    const otherBot = { author: { login: 'other-app', __typename: 'Bot' }, body: botBody };
    // Another App posting a marker is not a finding thread at all.
    expect(parseFindingThreadNode(node({ isResolved: true }, [otherBot, reason]), APP)).toBeNull();
    // GraphQL reports the slug, REST the [bot] suffix: both forms of the App's own login match.
    expect(parseFindingThreadNode(node({ isResolved: true }, [{ ...otherBot, author: { login: 'review-app', __typename: 'Bot' } }, reason]), APP)?.resolution)
      .toMatchObject({ author: 'author1' });
    // With the App login unknown, a thread is recognised for identity but never satisfies a P2.
    const unverified = parseFindingThreadNode(node({ isResolved: true }, [otherBot, reason]));
    expect(unverified).toMatchObject({ fingerprint, resolved: true });
    expect(unverified?.resolution).toBeUndefined();
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

  it('keeps v1 idempotency for a resolved P1 fingerprint from any prior run', async () => {
    const resolvedPrior = parseFindingThreadNode(node({ id: 'T_resolved_p1', isResolved: true }, [{
      author: { __typename: 'Bot', login: APP },
      body: renderFindingMarker({ fingerprint, severity: 'P1', title: finding.title }),
    }]))!;
    const fetchImplementation = vi.fn(async () => new Response('{}', { status: 201 }));
    const result = await publishFindingThreads({ token: TOKEN, fetchImplementation },
      { owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD },
      [{ ...finding, severity: 'P1', fingerprint }], [resolvedPrior]);

    expect(result).toEqual({ created: 0, skipped: 1 });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('lets v2 reopen a current P1 after a resolved same-fingerprint blocker thread', async () => {
    const resolvedPrior = parseFindingThreadNode(node({ id: 'T_resolved_p1', isResolved: true }, [{
      author: { __typename: 'Bot', login: APP },
      body: renderFindingMarker({ fingerprint, severity: 'P1', title: finding.title }),
    }]))!;
    const fetchImplementation = vi.fn(async () => new Response('{}', { status: 201 }));
    const result = await publishFindingThreads({ token: TOKEN, fetchImplementation },
      { owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD },
      [{ ...finding, severity: 'P1', fingerprint }], [resolvedPrior], 1, { replaceAdvisoryThreads: true });

    expect(result).toEqual({ created: 1, skipped: 0 });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('publishes every verified blocker when the service supplies the complete v2 list', async () => {
    const findings = Array.from({ length: 31 }, (_, index) => {
      const candidate = { severity: 'P1' as const, path: `src/defect-${index}.ts`, line: index + 1,
        title: `Defect ${index} breaks the ownership boundary`, body: 'The caller can read a protected record.' };
      return { ...candidate, fingerprint: findingFingerprint(candidate) };
    });
    const fetchImplementation = vi.fn(async () => new Response('{}', { status: 201 }));
    const result = await publishFindingThreads({ token: TOKEN, fetchImplementation },
      { owner: 'o', repo: 'r', prNumber: 7, headSha: HEAD }, findings, [], findings.length);
    expect(result).toEqual({ created: 31, skipped: 0 });
    expect(fetchImplementation).toHaveBeenCalledTimes(31);
  });

  it('derives the thread guidance from the same resolvability predicate the convergence decision enforces', () => {
    const satisfiable = { ...finding, severity: 'P2' as const, fingerprint };
    const unsatisfiable = { ...finding, severity: 'P1' as const, fingerprint };
    expect(isResolutionSatisfiable('P2')).toBe(true);
    expect(isResolutionSatisfiable('P1')).toBe(false);
    expect(isResolutionSatisfiable('P0')).toBe(false);
    expect(renderFindingThreadBody(satisfiable))
      .toContain('reply here with the reason it does not apply and resolve this conversation');
    expect(renderFindingThreadBody(unsatisfiable))
      .toContain('a resolved conversation does not clear a P0 or P1');
    expect(renderFindingThreadBody(unsatisfiable))
      .not.toContain('reply here with the reason it does not apply');
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
      return { token: 'ghs_servicewrite', fetchImplementation, botLogin: APP };
    });
    const server = express();
    server.use(express.json());
    server.post('/finding-threads', createFindingThreadsHandler({ db, transportFor }));
    return { server, db, calls, transportFor };
  };

  async function v2App(options: { existing?: unknown[]; liveHead?: string; blockers?: string[]; blockerFindings?: unknown[];
    p1Count?: number; failResolveOn?: number; workerEvidence?: (coordinates: any) => any } = {}) {
    const content = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
      personas: 'security,testing', budget: { max_investigation_turns: 20 },
      severity_policy: REVIEW_SEVERITY_POLICY_V2,
    } });
    const prepared = preparePublishingPolicy({ content, source: {
      repositoryId: 123, repository: 'o/r', sha: 'a'.repeat(40), path: 'policy/review-yeti.json',
      contentDigest: sha256(content),
    } }, { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
    const coordinates = { runId: RUN, repositoryId: 123, owner: 'o', repo: 'r', prNumber: 7,
      headSha: HEAD, baseSha: 'c'.repeat(40), policyDigest: prepared.policy.effectivePolicyDigest,
      configDigest: prepared.policy.effectiveConfigDigest, executionAttempt: 2 };
    const suppliedEvidence = await options.workerEvidence?.(coordinates);
    const decision = suppliedEvidence?.reviewDecision ?? createReviewDecisionV2({
      schemaVersion: 'review-yeti-decision.v2', policyVersion: REVIEW_SEVERITY_POLICY_V2,
      policyDigest: prepared.policy.effectivePolicyDigest, coverageComplete: true, quorumSatisfied: true,
      infrastructureFailure: false, expectedLanes: 2, completedLanes: 2,
      counts: { p0Count: 0, p1Count: options.p1Count ?? 0, p2Count: options.p1Count ? 0 : 1, p3Count: 0, nitCount: 0 },
    });
    const completionDigest = sha256('accepted-worker-completion');
    const blockerEvidence = {
      trigger: 'A request without a valid session reaches the protected handler.',
      impact: 'The request exposes another account holder private information.',
      violatedContract: 'Account data is readable only to its authenticated owner.',
    };
    const blocker = { ...finding, severity: 'P1', blockerEvidence };
    const gateEvidence = suppliedEvidence ?? { reviewDecision: decision, blockingFingerprints: options.blockers ?? [],
      blockingFindings: options.blockerFindings ?? (options.p1Count ? [{ ...blocker, fingerprint }] : []) };
    let storedPolicy: Record<string, unknown> | undefined;
    const db = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT INTO prepared_review_policies')) {
        storedPolicy = {
          effective_policy_digest: values?.[0], version: values?.[1], effective_config_digest: values?.[2],
          config: JSON.parse(String(values?.[3])), transport: JSON.parse(String(values?.[4])),
          sources: JSON.parse(String(values?.[5])), expected_persona_ids: JSON.parse(String(values?.[6])),
          prepared_content_digest: values?.[7],
        };
        return { rows: [] };
      }
      if (sql.includes('FROM prepared_review_policies')) return { rows: storedPolicy ? [storedPolicy] : [] };
      if (sql.includes('review_runs') && sql.includes('review_gate_attempts')
        && sql.includes('review_worker_completions')) {
        expect(values).toEqual([RUN, 2]);
        return { rows: [{
          repository_id: 123, owner: 'o', repo: 'r', pr_number: 7, head_sha: HEAD, base_sha: coordinates.baseSha,
          effective_policy_digest: prepared.policy.effectivePolicyDigest,
          effective_config_digest: prepared.policy.effectiveConfigDigest, run_status: 'failed', result_digest: completionDigest,
          worker_token_digest: sha256(TOKEN), previous_execution_attempt: 1,
          gate_coordinates: coordinates, gate_evidence: gateEvidence,
          gate_worker_result_digest: completionDigest,
          gate_decision: { status: options.p1Count ? 'failure' : 'success' },
          completion_execution_attempt: 2, completion_content_digest: completionDigest,
        }] };
      }
      throw new Error(`unexpected query ${sql}`);
    }) };
    await savePreparedPublishingPolicy(db, prepared);
    const calls: Array<{ url: string; body: any }> = [];
    let currentExisting = [...(options.existing ?? [])];
    let resolveAttempts = 0;
    let failedResolution = false;
    const fetchImplementation = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ url: String(url), body: parsed });
      if (String(url).endsWith('/pulls/7')) {
        return new Response(JSON.stringify({ head: { sha: options.liveHead ?? HEAD } }));
      }
      if (String(url).endsWith('/graphql') && String(parsed.query).includes('resolveReviewThread')) {
        resolveAttempts += 1;
        if (!failedResolution && resolveAttempts === options.failResolveOn) {
          failedResolution = true;
          return new Response(JSON.stringify({ errors: [{ message: 'temporary mutation failure' }] }));
        }
        currentExisting = currentExisting.map((thread: any) => thread.id === parsed.variables.threadId
          ? { ...thread, isResolved: true } : thread);
        return new Response(JSON.stringify({ data: { resolveReviewThread: { thread: { id: parsed.variables.threadId, isResolved: true } } } }));
      }
      if (String(url).endsWith('/graphql')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false }, nodes: currentExisting,
        } } } } }));
      }
      if (String(url).endsWith('/pulls/7/comments')) {
        currentExisting.push(node({ id: `T_created_${currentExisting.length + 1}` }, [{
          author: { login: APP, __typename: 'Bot' }, body: parsed.body, createdAt: '2026-10-05T00:00:00Z',
        }]));
        return new Response('{}', { status: 201 });
      }
      return new Response('{}', { status: 201 });
    });
    const server = express();
    server.use(express.json());
    server.post('/finding-threads', createFindingThreadsHandler({ db, transportFor: async () => ({
      token: 'ghs_servicewrite', fetchImplementation, botLogin: APP,
    }) }));
    const v2Body = (overrides: Record<string, unknown> = {}) => ({
      version: 'FindingThreadsRequest.v2', ...coordinates, reviewDecision: decision,
      ...overrides,
    });
    return { server, db, calls, fetchImplementation, decision, v2Body };
  }

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
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ version: 'FindingThreadsResult.v1', runId: RUN, created: 1, skipped: 0, resolved: 1 });
    const resolved = fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'));
    expect(resolved.map((call) => call.body.variables.threadId)).toEqual(['T_stale']);
    expect(fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'))).toHaveLength(1);
  });

  it('retires an unresolved bot P2 conversation when a complete trusted v2 run reclassifies it as advisory', async () => {
    const fixture = await v2App({ existing: [node()] });
    const response = await request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(fixture.v2Body());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ version: 'FindingThreadsResult.v2', created: 0, resolved: 1 });
    const resolved = fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'));
    expect(resolved.map((call) => call.body.variables.threadId)).toEqual(['T_1']);
  });

  it('authenticates an idempotent retry after the run is terminal and the worker lease is released', async () => {
    const secondFinding = { ...finding, title: 'Less useful validation message' };
    const secondNode = node({ id: 'T_2' }, [{ author: { login: APP, __typename: 'Bot' },
      body: renderFindingThreadBody({ ...secondFinding, fingerprint: findingFingerprint(secondFinding) }) }]);
    const fixture = await v2App({ existing: [node(), secondNode], failResolveOn: 2 });
    const send = () => request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`).send(fixture.v2Body());

    const partial = await send();
    expect(partial.status).toBe(503);
    const retry = await send();
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ version: 'FindingThreadsResult.v2', resolved: 1 });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ resolved: 0 });
    expect(fixture.db.query.mock.calls.some(([sql]) => String(sql).includes('review_worker_completions'))).toBe(true);
  });

  it('keeps a same-fingerprint prior P2 open when the accepted current completion verifies P1', async () => {
    const oldResolved = node({ isResolved: true }, [
      { author: { login: APP, __typename: 'Bot' }, body: botBody },
      { author: { login: 'author1', __typename: 'User' }, body: 'Intentional: this remains an accepted prior reason.' },
    ]);
    const fixture = await v2App({ existing: [oldResolved], blockers: [fingerprint], p1Count: 1 });
    const response = await request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(fixture.v2Body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: 'FindingThreadsResult.v2', created: 1, resolved: 0 });
    expect(fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'))).toHaveLength(1);
    expect(fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'))).toHaveLength(0);
  });

  it('publishes the same-fingerprint v2 P1 before retiring its open prior P2 and retries idempotently', async () => {
    const fixture = await v2App({ existing: [node()], blockers: [fingerprint], p1Count: 1, failResolveOn: 1 });
    const send = () => request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(fixture.v2Body());

    const partial = await send();
    expect(partial.status).toBe(503);
    const firstPosts = fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'));
    expect(firstPosts).toHaveLength(1);
    expect(firstPosts[0]?.body.body).toContain('**[P1 · required]**');
    expect(fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'))).toHaveLength(1);

    const retry = await send();
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ version: 'FindingThreadsResult.v2', created: 0, skipped: 1, resolved: 1 });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ created: 0, skipped: 1, resolved: 0 });
    expect(fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'))).toHaveLength(1);
  });

  it('publishes and retires a P2-first/P1-second cluster from the accepted worker completion', async () => {
    const blockerEvidence = {
      trigger: 'A request without a valid session reaches the profile lookup.',
      impact: 'The handler returns another account holder private profile data.',
      violatedContract: 'Profile data is readable only by its authenticated owner.',
    };
    const advisory = { severity: 'P2' as const, path: 'src/mod.ts', line: 2,
      title: 'Profile lookup lacks a session guard', body: 'Requests without a session reach the profile lookup.' };
    const verified = { ...advisory, severity: 'P1' as const, line: 3,
      body: 'An unauthenticated request reaches the profile lookup and returns private account data.', blockerEvidence };
    const changedFiles = [{ path: 'src/mod.ts', patch: '@@ -1,0 +1,3 @@\n+first();\n+second();\n+return profile;' }];
    const workerEvidence = async (coordinates: any) => {
      const personas: any[] = [
        { id: 'security', decision: 'FINDINGS', findings: [advisory] },
        { id: 'testing', decision: 'FINDINGS', findings: [verified] },
      ];
      const canonical = computeArbitration(personas, 2, {
        changedFiles, coverageComplete: true, severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      });
      const reviewDecision = createReviewDecisionV2({
        schemaVersion: 'review-yeti-decision.v2', policyVersion: REVIEW_SEVERITY_POLICY_V2,
        policyDigest: coordinates.policyDigest, coverageComplete: true, quorumSatisfied: true,
        infrastructureFailure: false, expectedLanes: 2, completedLanes: canonical.completedPersonas,
        counts: {
          p0Count: canonical.metrics.p0Count, p1Count: canonical.metrics.p1Count,
          p2Count: canonical.metrics.p2Count, p3Count: canonical.metrics.p3Count, nitCount: canonical.metrics.nitCount,
        },
      });
      const completion = {
        version: 'WorkerReviewCompletion.v1', ...coordinates,
        result: {
          version: 'WorkerReviewResult.v1', completedAt: '2026-10-05T00:00:00.000Z', personas,
          coverageComplete: true, quorumSatisfied: true, verdict: canonical.verdict,
          findingCount: canonical.metrics.totalFindings,
          blockingFindingCount: canonical.metrics.p0Count + canonical.metrics.p1Count,
          reviewDecision,
        },
      };
      const verifierFindings = personas.flatMap((persona) => persona.findings) as unknown as Record<string, unknown>[];
      completion.result.groundedReview = await groundedFixtureReceipt({
        findings: verifierFindings, changedFiles,
        owner: coordinates.owner, repo: coordinates.repo, headSha: coordinates.headSha, baseSha: coordinates.baseSha,
        severityPolicyVersion: REVIEW_SEVERITY_POLICY_V2,
      });
      const derived = deriveCanonicalWorkerReviewEvidence(completion as any, {
        expectedCoordinates: coordinates,
        expectedPersonaIds: ['security', 'testing'],
        changedFiles,
        coverageComplete: true,
        quorumSatisfied: true,
        reviewDecisionPolicy: REVIEW_SEVERITY_POLICY_V2,
      });
      if (!derived.valid) throw new Error(derived.message);
      return derived.evidence;
    };
    const priorP2 = node({ id: 'T_prior_p2', path: 'src/mod.ts', line: 2 }, [{
      author: { login: APP, __typename: 'Bot' },
      body: renderFindingThreadBody({ ...advisory, fingerprint: findingFingerprint(advisory) }),
    }]);
    const fixture = await v2App({ existing: [priorP2], p1Count: 1, workerEvidence });

    const response = await request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(fixture.v2Body());

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ version: 'FindingThreadsResult.v2', created: 1, resolved: 1 });
    expect(fixture.calls.find((call) => call.url.endsWith('/pulls/7/comments'))?.body.body).toContain('**[P1 · required]**');
    expect(fixture.calls.filter((call) => String(call.body.query).includes('resolveReviewThread')))
      .toMatchObject([{ body: { variables: { threadId: 'T_prior_p2' } } }]);
  });

  it('rejects stale-head and forged v2 receipts before mutating bot threads', async () => {
    const oldThread = node();
    const stale = await v2App({ existing: [oldThread], liveHead: 'f'.repeat(40) });
    const staleResponse = await request(stale.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(stale.v2Body());
    expect(staleResponse.status).toBe(409);
    expect(stale.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'))).toHaveLength(0);

    const forged = await v2App({ existing: [oldThread] });
    const badResponse = await request(forged.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(forged.v2Body({ reviewDecision: { ...forged.decision, eligible: false } }));
    expect(badResponse.status).toBe(409);
    expect(forged.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'))).toHaveLength(0);

    const mismatchedStoredFingerprint = await v2App({ blockers: ['fp1_' + 'a'.repeat(24)], p1Count: 1 });
    const mismatch = await request(mismatchedStoredFingerprint.server).post('/finding-threads')
      .set('Authorization', `Bearer ${TOKEN}`).send(mismatchedStoredFingerprint.v2Body());
    expect(mismatch.status).toBe(409);
    expect(mismatchedStoredFingerprint.calls).toHaveLength(0);

    const unknown = await request(forged.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send(forged.v2Body({ version: 'FindingThreadsRequest.v3' }));
    expect(unknown.status).toBe(400);
    expect(forged.calls.filter((call) => String(call.body.query).includes('resolveReviewThread'))).toHaveLength(0);
  });

  it('reads the App\'s own threads for the worker, author-verified, on the run\'s exact head', async () => {
    const resolvedNode = node({ isResolved: true }, [
      { author: { login: 'review-app[bot]', __typename: 'Bot' }, body: botBody },
      { author: { login: 'author1', __typename: 'User' }, body: 'Intentional: mirrors the public API naming.' },
    ]);
    const spoofed = node({ id: 'T_spoof' }, [{ author: { login: 'other-app', __typename: 'Bot' }, body: botBody }]);
    const fixture = app({ existing: [resolvedNode, spoofed] });
    const response = await request(fixture.server).post('/finding-threads').set('Authorization', `Bearer ${TOKEN}`)
      .send({ version: 'FindingThreadsRead.v1', runId: RUN, executionAttempt: 1, headSha: HEAD });
    expect(response.status).toBe(200);
    expect(response.body.version).toBe('FindingThreadsReadResult.v1');
    expect(response.body.threads.map((thread: any) => thread.threadId)).toEqual(['T_1']);
    expect(response.body.threads[0].resolution).toMatchObject({ author: 'author1' });
    expect(fixture.calls.filter((call) => call.url.endsWith('/pulls/7/comments'))).toHaveLength(0);
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

  it('retries the exact v2 post-completion request once after a transient service failure', async () => {
    const attempts: unknown[] = [];
    const fetchImplementation = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      attempts.push(body);
      return attempts.length === 1
        ? new Response('{}', { status: 503 })
        : new Response(JSON.stringify({ version: 'FindingThreadsResult.v2', runId: RUN, created: 0, skipped: 0, resolved: 1 }));
    });
    const client = new HttpFindingThreadsPublisher({ token: TOKEN,
      completionEndpoint: 'https://svc.example.invalid/api/dispatch/completion', runId: RUN,
      executionAttempt: 2, fetchImplementation });
    const requestV2 = {
      headSha: HEAD, baseSha: 'c'.repeat(40), repositoryId: 123, owner: 'o', repo: 'r', prNumber: 7,
      policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), reviewDecision: v2Decision,
    };
    await expect(client.publish(requestV2)).resolves.toEqual({ created: 0, skipped: 0, resolved: 1 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0]).toMatchObject({ version: 'FindingThreadsRequest.v2', runId: RUN, executionAttempt: 2 });
    expect(attempts[0]).not.toHaveProperty('publish');
    expect(attempts[0]).not.toHaveProperty('reported');
  });
});
