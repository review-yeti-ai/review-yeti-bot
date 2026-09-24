import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { createIncrementalCompareReader } from '../../src/github/incrementalCompareReader';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { HttpIncrementalBaseSource, incrementalBaseEndpointFor } from '../../src/review/incrementalBaseHttp';
import type { IncrementalVerificationInput, PriorReviewRecord } from '../../src/review/incrementalReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { publishingWorkerAdapters } from '../../src/review/publishingWorkerAdapters';
import { sha256 } from '../../src/review/reviewCore';

/**
 * REL-1084: the trusted completion side re-decides a carried-forward completion
 * from its own prior record and exact-SHA comparisons; the worker's planning read
 * and GitHub comparison transport. Negative proof: a force-pushed head, a claim
 * that carries an open-finding file, and a reader without comparisons each leave
 * the claim unverified.
 */

const TOKEN = 'ghs_incremental.header.signature';
const API = 'https://api.github.com';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PREV_HEAD = '1'.repeat(40);
const PREV_BASE = '2'.repeat(40);
const MERGE_BASE = '3'.repeat(40);
const PRIOR_RUN = `run_${'9'.repeat(32)}`;
const RUN = `run_${'1'.repeat(32)}`;
const target = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42, headSha: HEAD, baseSha: BASE };
const repository = { repositoryId: 123, owner: 'example', repo: 'candidate' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function comparisonBody(base: string, head: string, status: string, paths: string[], mergeBase = MERGE_BASE) {
  return {
    url: `${API}/repos/example/candidate/compare/${base}...${head}`,
    base_commit: { sha: base }, merge_base_commit: { sha: mergeBase },
    status, ahead_by: 1, behind_by: 0, total_commits: 1,
    files: paths.map((path) => ({ sha: 'c'.repeat(40), filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2,
      patch: '@@ -1 +1 @@\n-old\n+new' })),
  };
}

function githubFetch(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    [`${PREV_HEAD}...${HEAD}`]: comparisonBody(PREV_HEAD, HEAD, 'ahead', ['src/a.ts'], PREV_HEAD),
    [`${PREV_BASE}...${PREV_HEAD}`]: comparisonBody(PREV_BASE, PREV_HEAD, 'ahead', ['src/a.ts', 'src/b.ts', 'src/open.ts']),
    [`${BASE}...${HEAD}`]: comparisonBody(BASE, HEAD, 'ahead', ['src/a.ts', 'src/b.ts', 'src/open.ts']),
    ...overrides,
  };
  return vi.fn<typeof fetch>(async (input) => {
    const match = /compare\/([a-f0-9]{40}\.\.\.[a-f0-9]{40})\?/u.exec(String(input));
    const body = match ? bodies[match[1]] : undefined;
    return body === undefined ? json({ message: 'Not Found' }, 404) : json(body);
  });
}

describe('AuthoritativeReviewReader.commitComparison', () => {
  it('returns the status, merge base and listed paths, bound to the exact base and head', async () => {
    const fetcher = githubFetch({
      [`${PREV_HEAD}...${HEAD}`]: { ...comparisonBody(PREV_HEAD, HEAD, 'ahead', []), files: [
        { sha: 'c'.repeat(40), filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, changes: 0 },
      ] },
    });
    const reader = new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: fetcher });
    expect(await reader.commitComparison(repository, PREV_HEAD, HEAD)).toEqual({
      status: 'ahead', mergeBaseSha: MERGE_BASE, files: [{ path: 'src/new.ts', previousPath: 'src/old.ts' }],
    });
    expect(String(fetcher.mock.calls[0][0])).toBe(`${API}/repos/example/candidate/compare/${PREV_HEAD}...${HEAD}?per_page=1&page=1`);
  });

  it('refuses a response for a different comparison or base, and a malformed SHA', async () => {
    const wrongUrl = githubFetch({ [`${PREV_HEAD}...${HEAD}`]: { ...comparisonBody(PREV_HEAD, HEAD, 'ahead', []), url: `${API}/repos/example/other/compare/x` } });
    await expect(new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: wrongUrl })
      .commitComparison(repository, PREV_HEAD, HEAD)).rejects.toThrow('comparison identity mismatch');
    const wrongBase = githubFetch({ [`${PREV_HEAD}...${HEAD}`]: { ...comparisonBody(PREV_HEAD, HEAD, 'ahead', []), base_commit: { sha: BASE } } });
    await expect(new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: wrongBase })
      .commitComparison(repository, PREV_HEAD, HEAD)).rejects.toThrow('comparison identity mismatch');
    await expect(new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: githubFetch() })
      .commitComparison(repository, 'main', HEAD)).rejects.toThrow();
  });

  it('is built fail-soft for the worker: an unusable token yields no reader', () => {
    expect(createIncrementalCompareReader({ token: 'not-a-token', repositoryId: 1, owner: 'a', repo: 'b' })).toBeUndefined();
    expect(createIncrementalCompareReader({ token: TOKEN, repositoryId: 1, owner: 'a', repo: 'b' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Trusted completion context
// ---------------------------------------------------------------------------

const current = { ...target, open: true, draft: false };
const diff = ['src/a.ts', 'src/b.ts', 'src/open.ts']
  .map((path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`).join('');

function policyFile() {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 3 },
  } });
  return { content, source: { repositoryId: 456, repository: 'example/central-policy',
    sha: 'c'.repeat(40), path: 'policy/review.json', contentDigest: sha256(content) } };
}

function contextFixture(fetcher: typeof fetch | null) {
  const stored = preparePublishingPolicy(policyFile(), { baseUrl: 'https://gateway.example.invalid/v1', model: 'review-model' });
  const policyDigest = stored.policy.effectivePolicyDigest;
  const configDigest = stored.policy.effectiveConfigDigest;
  const gate: StoredReviewGate = {
    coordinates: { ...target, runId: RUN, policyDigest, attemptId: `${RUN}-g0-e1`, executionAttempt: 1 },
    reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
    creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
  };
  const real = fetcher ? new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: fetcher }) : null;
  const readerFactory = vi.fn<AuthoritativeCompletionContextOptions['readerFactory']>(async () => ({
    currentCandidate: vi.fn(async () => ({ ...current })),
    exactCurrentDiff: vi.fn(async () => ({ current: { ...current }, diff, expectedFileCount: 3 })),
    ...(real ? { commitComparison: real.commitComparison.bind(real) } : {}),
  }));
  const refreshed = structuredClone(stored);
  const context = createAuthoritativeCompletionContext({
    getStoredPrepared: vi.fn(async () => stored),
    readerFactory,
    publishingResolver: { resolve: vi.fn(async () => ({ current: { ...current }, prepared: refreshed,
      identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: refreshed.policy }) })) },
  });
  const prior: PriorReviewRecord = {
    runId: PRIOR_RUN, executionAttempt: 1, repositoryId: 123, prNumber: 42, headSha: PREV_HEAD, baseSha: PREV_BASE,
    policyDigest, configDigest, completionDigest: 'e'.repeat(64), ageMs: 60_000, shipComplete: true, findingPaths: ['src/open.ts'],
  };
  const incremental = (carriedForwardPaths: string[], overrides: Partial<IncrementalVerificationInput> = {}): IncrementalVerificationInput => ({
    claim: { version: 'IncrementalReview.v1', previousRunId: PRIOR_RUN, previousExecutionAttempt: 1,
      previousHeadSha: PREV_HEAD, previousBaseSha: PREV_BASE, previousCompletionDigest: 'e'.repeat(64), carriedForwardPaths },
    prior, maxAgeMs: 3_600_000, run: { runId: RUN, executionAttempt: 1, configDigest },
    ...overrides,
  });
  return { context, gate, incremental, prior };
}

describe('trusted completion context verification', () => {
  it('verifies a claim the shared decision permits', async () => {
    const f = contextFixture(githubFetch());
    const trusted = await f.context(f.gate, f.incremental(['src/b.ts']));
    expect(trusted.coverage.incrementalVerified).toBe(true);
    expect(trusted.coverage.changedFiles.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/open.ts']);
  });

  it('leaves the contract untouched without a claim', async () => {
    const f = contextFixture(githubFetch());
    expect(await f.context(f.gate)).not.toHaveProperty('coverage.incrementalVerified');
  });

  it('does not verify a claim carrying a file with an open finding (planted)', async () => {
    const f = contextFixture(githubFetch());
    expect((await f.context(f.gate, f.incremental(['src/b.ts', 'src/open.ts']))).coverage.incrementalVerified).toBe(false);
  });

  it('does not verify after a force-push, with a stale or foreign record, or without comparisons', async () => {
    const forced = contextFixture(githubFetch({ [`${PREV_HEAD}...${HEAD}`]: comparisonBody(PREV_HEAD, HEAD, 'diverged', ['src/a.ts']) }));
    expect((await forced.context(forced.gate, forced.incremental(['src/b.ts']))).coverage.incrementalVerified).toBe(false);
    const f = contextFixture(githubFetch());
    expect((await f.context(f.gate, f.incremental(['src/b.ts'], { maxAgeMs: 1_000 }))).coverage.incrementalVerified).toBe(false);
    expect((await f.context(f.gate, f.incremental(['src/b.ts'], { prior: null }))).coverage.incrementalVerified).toBe(false);
    expect((await f.context(f.gate, f.incremental(['src/b.ts'], { prior: { ...f.prior, configDigest: 'f'.repeat(64) } })))
      .coverage.incrementalVerified).toBe(false);
    const blind = contextFixture(null);
    expect((await blind.context(blind.gate, blind.incremental(['src/b.ts']))).coverage.incrementalVerified).toBe(false);
  });

  it('treats a GitHub comparison failure as transient, never as verified', async () => {
    const f = contextFixture(vi.fn<typeof fetch>(async () => json({ message: 'boom' }, 502)));
    await expect(f.context(f.gate, f.incremental(['src/b.ts']))).rejects.toThrow('Authoritative completion context unavailable');
  });
});

// ---------------------------------------------------------------------------
// Worker planning read: HTTP client, route and adapter
// ---------------------------------------------------------------------------

const prior: PriorReviewRecord = {
  runId: PRIOR_RUN, executionAttempt: 1, repositoryId: 123, prNumber: 42, headSha: PREV_HEAD, baseSha: PREV_BASE,
  policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), completionDigest: 'e'.repeat(64), ageMs: 60_000,
  shipComplete: true, findingPaths: [],
};

describe('worker incremental base client', () => {
  it('derives its endpoint from the completion endpoint only', () => {
    expect(incrementalBaseEndpointFor('https://svc.example/api/dispatch/completion'))
      .toBe('https://svc.example/api/dispatch/incremental-base');
    expect(() => incrementalBaseEndpointFor('https://svc.example/api/dispatch/other')).toThrow();
    expect(() => incrementalBaseEndpointFor('http://svc.example/api/dispatch/completion')).toThrow();
  });

  it('posts its run identity with its bearer and returns the validated record', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ version: 'IncrementalBase.v1', runId: RUN, maxAgeMs: 3_600_000, prior }));
    const source = new HttpIncrementalBaseSource({ token: TOKEN, completionEndpoint: 'https://svc.example/api/dispatch/completion',
      runId: RUN, executionAttempt: 1, fetchImplementation: fetcher });
    expect(await source.read()).toEqual({ prior, maxAgeMs: 3_600_000 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://svc.example/api/dispatch/incremental-base');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(String(init?.body))).toEqual({ version: 'IncrementalBaseRequest.v1', runId: RUN, executionAttempt: 1 });
  });

  it('rejects a non-200, another run\'s answer, or a malformed record', async () => {
    const read = (response: Response) => new HttpIncrementalBaseSource({ token: TOKEN,
      completionEndpoint: 'https://svc.example/api/dispatch/completion', runId: RUN, executionAttempt: 1,
      fetchImplementation: vi.fn<typeof fetch>(async () => response) }).read();
    await expect(read(json({ error: 'x' }, 503))).rejects.toThrow('Incremental base could not be read');
    await expect(read(json({ version: 'IncrementalBase.v1', runId: PRIOR_RUN, maxAgeMs: 1, prior: null }))).rejects.toThrow();
    await expect(read(json({ version: 'IncrementalBase.v1', runId: RUN, maxAgeMs: 1, prior: { ...prior, ageMs: -1 } }))).rejects.toThrow();
  });

  it('is built by the worker adapters only when the flag names the repository', () => {
    const env = { REVIEW_COMPLETION_URL: 'https://svc.example/api/dispatch/completion', REVIEW_REPO: 'acme/app',
      REVIEW_RUN_ID: RUN, REVIEW_EXECUTION_ATTEMPT: '1' };
    expect(publishingWorkerAdapters(env, TOKEN)).not.toHaveProperty('incrementalBase');
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_INCREMENTAL: 'acme/app' }, TOKEN).incrementalBase)
      .toBeInstanceOf(HttpIncrementalBaseSource);
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_INCREMENTAL: 'acme/app', REVIEW_AUTHORITATIVE_GATE: 'true' }, TOKEN).incrementalBase)
      .toBeInstanceOf(HttpIncrementalBaseSource);
    // Fail-soft: a source that cannot be built leaves the run on a full review.
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_INCREMENTAL: 'all', REVIEW_RUN_ID: 'bad' }, TOKEN))
      .not.toHaveProperty('incrementalBase');
  });
});

describe('incremental base route', () => {
  function app(read = vi.fn(async () => ({ status: 'ok' as const, prior, maxAgeMs: 3_600_000 }))) {
    const server = express();
    server.use(express.json());
    server.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn() } as never, admission: { admit: vi.fn() } as never, resolveInstallationId: vi.fn(),
      incrementalBase: { read },
    }));
    return { server, read };
  }
  const body = { version: 'IncrementalBaseRequest.v1', runId: RUN, executionAttempt: 1 };

  it('answers the authenticated worker with the service record', async () => {
    const { server, read } = app();
    const res = await request(server).post('/api/dispatch/incremental-base').set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 'IncrementalBase.v1', runId: RUN, maxAgeMs: 3_600_000, prior });
    expect(read).toHaveBeenCalledWith({ runId: RUN, executionAttempt: 1, workerTokenDigest: sha256(TOKEN) });
  });

  it('refuses a missing bearer, a malformed body, an unauthorized worker, and reports storage failure as 503', async () => {
    expect((await request(app().server).post('/api/dispatch/incremental-base').send(body)).status).toBe(401);
    expect((await request(app().server).post('/api/dispatch/incremental-base').set('Authorization', `Bearer ${TOKEN}`)
      .send({ ...body, extra: 1 })).status).toBe(400);
    const denied = app(vi.fn(async () => ({ status: 'unauthorized' as const })) as never);
    expect((await request(denied.server).post('/api/dispatch/incremental-base').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(403);
    const broken = app(vi.fn(async () => { throw new Error('db down'); }) as never);
    const res = await request(broken.server).post('/api/dispatch/incremental-base').set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('db down');
  });

  it('is not mounted unless the service configures it', async () => {
    const server = express();
    server.use(express.json());
    server.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn() } as never, admission: { admit: vi.fn() } as never, resolveInstallationId: vi.fn(),
    }));
    expect((await request(server).post('/api/dispatch/incremental-base').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(404);
  });
});
