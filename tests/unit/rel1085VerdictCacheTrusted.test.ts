import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import { AuthoritativeReviewReader } from '../../src/github/authoritativeReviewReader';
import { createVerdictCacheCompareReader } from '../../src/github/verdictCacheCompareReader';
import type { StoredReviewGate } from '../../src/persistence/reviewGateRepository';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { buildEffectiveReviewFiles } from '../../src/review/personaApplicability';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { publishingWorkerAdapters } from '../../src/review/publishingWorkerAdapters';
import { sha256 } from '../../src/review/reviewCore';
import {
  contentKeyOf,
  viewDigestOf,
  type VerdictCacheSource,
  type VerdictCacheVerificationInput,
} from '../../src/review/verdictCache';
import { HttpVerdictCacheBaseSource, verdictCacheBaseEndpointFor } from '../../src/review/verdictCacheBaseHttp';

/**
 * REL-1085: the trusted completion side re-decides a completion that served
 * files from the verdict cache, from its own source record, exact-SHA
 * comparisons and its own applicability routing; the worker's planning read and
 * GitHub comparison transport. Negative proof: a changed blob, a lane the
 * service routes that the source never ran, and a reader without comparisons
 * each leave the served files unverified.
 */

const TOKEN = 'ghs_verdict.header.signature';
const API = 'https://api.github.com';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const SOURCE_HEAD = '1'.repeat(40);
const SOURCE_BASE = '2'.repeat(40);
const SOURCE_RUN = `run_${'9'.repeat(32)}`;
const RUN = `run_${'1'.repeat(32)}`;
const REPO_ID = 123;
const target = { repositoryId: REPO_ID, owner: 'example', repo: 'candidate', prNumber: 42, headSha: HEAD, baseSha: BASE };
const repository = { repositoryId: REPO_ID, owner: 'example', repo: 'candidate' };
const PATCH = (path: string) => `@@ -1 +1 @@\n-old ${path}\n+new ${path}`;
const BLOBS: Record<string, string> = { 'src/a.ts': 'c'.repeat(40), 'src/b.ts': 'd'.repeat(40) };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function comparisonBody(base: string, head: string, entries: Array<{ path: string; sha: string; patch?: string }>) {
  return {
    url: `${API}/repos/example/candidate/compare/${base}...${head}`,
    base_commit: { sha: base }, merge_base_commit: { sha: base },
    status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
    files: entries.map((entry) => ({ sha: entry.sha, filename: entry.path, status: 'modified', additions: 1, deletions: 1, changes: 2,
      ...(entry.patch === undefined ? {} : { patch: entry.patch }) })),
  };
}

function githubFetch(overrides: Record<string, unknown> = {}) {
  const both = Object.keys(BLOBS).map((path) => ({ path, sha: BLOBS[path], patch: PATCH(path) }));
  const bodies: Record<string, unknown> = {
    [`${SOURCE_BASE}...${SOURCE_HEAD}`]: comparisonBody(SOURCE_BASE, SOURCE_HEAD, both),
    [`${BASE}...${HEAD}`]: comparisonBody(BASE, HEAD, both),
    ...overrides,
  };
  return vi.fn<typeof fetch>(async (input) => {
    const match = /compare\/([a-f0-9]{40}\.\.\.[a-f0-9]{40})\?/u.exec(String(input));
    const body = match ? bodies[match[1]] : undefined;
    return body === undefined ? json({ message: 'Not Found' }, 404) : json(body);
  });
}

describe('AuthoritativeReviewReader.comparisonContent', () => {
  it('returns each file\'s blob, status and complete patch, bound to the exact base and head', async () => {
    const fetcher = githubFetch({ [`${BASE}...${HEAD}`]: comparisonBody(BASE, HEAD, [
      { path: 'src/a.ts', sha: BLOBS['src/a.ts'], patch: PATCH('src/a.ts') },
      { path: 'src/binary.png', sha: 'e'.repeat(40) },
    ]) });
    const reader = new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: fetcher });
    expect(await reader.comparisonContent(repository, BASE, HEAD)).toEqual({ files: [
      { path: 'src/a.ts', blobSha: BLOBS['src/a.ts'], status: 'modified', patch: PATCH('src/a.ts') },
      { path: 'src/binary.png', blobSha: 'e'.repeat(40), status: 'modified' },
    ] });
    expect(String(fetcher.mock.calls[0][0])).toBe(`${API}/repos/example/candidate/compare/${BASE}...${HEAD}?per_page=1&page=1`);
    // The W7 comparison shape is unchanged by the shared parse.
    expect(await reader.commitComparison(repository, BASE, HEAD)).toEqual({
      status: 'ahead', mergeBaseSha: BASE, files: [{ path: 'src/a.ts' }, { path: 'src/binary.png' }],
    });
  });

  it('refuses a response for a different comparison or base', async () => {
    const wrong = githubFetch({ [`${BASE}...${HEAD}`]: { ...comparisonBody(BASE, HEAD, []), url: `${API}/repos/example/other/compare/x` } });
    await expect(new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: wrong })
      .comparisonContent(repository, BASE, HEAD)).rejects.toThrow('comparison identity mismatch');
  });

  it('is built fail-soft for the worker: an unusable token yields no reader', async () => {
    expect(createVerdictCacheCompareReader({ token: 'not-a-token', repositoryId: 1, owner: 'a', repo: 'b' })).toBeUndefined();
    const reader = createVerdictCacheCompareReader({ token: TOKEN, repositoryId: REPO_ID, owner: 'example', repo: 'candidate',
      baseUrl: API, fetchImplementation: githubFetch() });
    expect((await reader!.content(BASE, HEAD)).files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

// ---------------------------------------------------------------------------
// Trusted completion context
// ---------------------------------------------------------------------------

const current = { ...target, open: true, draft: false };
const diff = Object.keys(BLOBS)
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
  const lanes = stored.config.personas.filter((persona) => persona.enabled).map((persona) => persona.id).sort();
  const gate: StoredReviewGate = {
    coordinates: { ...target, runId: RUN, policyDigest, attemptId: `${RUN}-g0-e1`, executionAttempt: 1 },
    reviewGeneration: 0, expectedAppId: 1234, externalId: 'service-gate', checkId: 456,
    creationState: 'bound', desiredState: 'in_progress', desiredVersion: 1, publishedVersion: 1, current: true,
  };
  const real = fetcher ? new AuthoritativeReviewReader({ token: TOKEN, baseUrl: API, fetchImplementation: fetcher }) : null;
  const readerFactory = vi.fn<AuthoritativeCompletionContextOptions['readerFactory']>(async () => ({
    currentCandidate: vi.fn(async () => ({ ...current })),
    exactCurrentDiff: vi.fn(async () => ({ current: { ...current }, diff, expectedFileCount: 2 })),
    ...(real ? { comparisonContent: real.comparisonContent.bind(real), commitComparison: real.commitComparison.bind(real) } : {}),
  }));
  const refreshed = structuredClone(stored);
  const context = createAuthoritativeCompletionContext({
    getStoredPrepared: vi.fn(async () => stored),
    readerFactory,
    publishingResolver: { resolve: vi.fn(async () => ({ current: { ...current }, prepared: refreshed,
      identity: buildAuthoritativeReviewIdentity({ requested: target, current, policy: refreshed.policy }) })) },
  });
  const laneKeys = Object.fromEntries(lanes.map((lane) => [lane, sha256(`lane ${lane}`)]));
  const viewOf = (path: string) => viewDigestOf(buildEffectiveReviewFiles(parseChangedFiles(diff).files)
    .files.find((file) => file.path === path)!.patch!);
  const source: VerdictCacheSource = {
    prior: {
      runId: SOURCE_RUN, executionAttempt: 1, repositoryId: REPO_ID, prNumber: 42, headSha: SOURCE_HEAD, baseSha: SOURCE_BASE,
      policyDigest, configDigest, completionDigest: 'e'.repeat(64), ageMs: 60_000, shipComplete: true, findingPaths: [],
    },
    laneKeys,
    entries: Object.keys(BLOBS).map((path) => ({
      path,
      contentKey: contentKeyOf(REPO_ID, { path, status: 'modified', blobSha: BLOBS[path], patch: PATCH(path) })!,
      viewDigest: viewOf(path),
      lanes,
    })),
    lanes,
  };
  const verdictCache = (paths: string[], overrides: Partial<VerdictCacheVerificationInput> = {}): VerdictCacheVerificationInput => ({
    claim: { version: 'VerdictCache.v1', laneKeys, entries: [],
      hits: { runId: SOURCE_RUN, executionAttempt: 1, completionDigest: 'e'.repeat(64), paths } },
    source, maxAgeMs: 3_600_000, run: { runId: RUN, executionAttempt: 1, configDigest },
    ...overrides,
  });
  return { context, gate, verdictCache, source, lanes };
}

describe('trusted completion context verification', () => {
  it('verifies served files the shared decision and the service\'s own routing permit', async () => {
    const f = contextFixture(githubFetch());
    const trusted = await f.context(f.gate, undefined, f.verdictCache(['src/b.ts']));
    expect(trusted.coverage.verdictCacheVerified).toBe(true);
    expect(trusted.coverage).not.toHaveProperty('incrementalVerified');
  });

  it('leaves the contract untouched without served files, including an entries-only record', async () => {
    const f = contextFixture(githubFetch());
    expect(await f.context(f.gate)).not.toHaveProperty('coverage.verdictCacheVerified');
    const entriesOnly = f.verdictCache([]);
    delete (entriesOnly.claim as { hits?: unknown }).hits;
    expect(await f.context(f.gate, undefined, entriesOnly)).not.toHaveProperty('coverage.verdictCacheVerified');
  });

  it('does not verify a served file whose blob changed (planted content change)', async () => {
    const changed = githubFetch({ [`${BASE}...${HEAD}`]: comparisonBody(BASE, HEAD, [
      { path: 'src/a.ts', sha: BLOBS['src/a.ts'], patch: PATCH('src/a.ts') },
      { path: 'src/b.ts', sha: 'f'.repeat(40), patch: PATCH('src/b.ts') },
    ]) });
    const f = contextFixture(changed);
    expect((await f.context(f.gate, undefined, f.verdictCache(['src/b.ts']))).coverage.verdictCacheVerified).toBe(false);
  });

  it('does not verify when the service routes a lane the source never ran, or with a stale or foreign record', async () => {
    const f = contextFixture(githubFetch());
    const narrow = { ...f.source, entries: f.source.entries.map((entry) => ({ ...entry, lanes: [f.lanes[0]] })) };
    expect((await f.context(f.gate, undefined, f.verdictCache(['src/b.ts'], { source: narrow }))).coverage.verdictCacheVerified).toBe(false);
    expect((await f.context(f.gate, undefined, f.verdictCache(['src/b.ts'], { maxAgeMs: 1_000 }))).coverage.verdictCacheVerified).toBe(false);
    expect((await f.context(f.gate, undefined, f.verdictCache(['src/b.ts'], { source: null }))).coverage.verdictCacheVerified).toBe(false);
    const foreign = { ...f.source, prior: { ...f.source.prior, repositoryId: 999 } };
    expect((await f.context(f.gate, undefined, f.verdictCache(['src/b.ts'], { source: foreign }))).coverage.verdictCacheVerified).toBe(false);
    const blind = contextFixture(null);
    expect((await blind.context(blind.gate, undefined, blind.verdictCache(['src/b.ts']))).coverage.verdictCacheVerified).toBe(false);
  });

  it('treats a GitHub comparison failure as transient, never as verified', async () => {
    const f = contextFixture(vi.fn<typeof fetch>(async () => json({ message: 'boom' }, 502)));
    await expect(f.context(f.gate, undefined, f.verdictCache(['src/b.ts']))).rejects.toThrow('Authoritative completion context unavailable');
  });
});

// ---------------------------------------------------------------------------
// Worker planning read: HTTP client, route and adapter
// ---------------------------------------------------------------------------

const planningSource: VerdictCacheSource = {
  prior: {
    runId: SOURCE_RUN, executionAttempt: 1, repositoryId: REPO_ID, prNumber: 42, headSha: SOURCE_HEAD, baseSha: SOURCE_BASE,
    policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), completionDigest: 'e'.repeat(64), ageMs: 60_000,
    shipComplete: true, findingPaths: [],
  },
  laneKeys: { 'sec-lane': 'a'.repeat(64) },
  entries: [{ path: 'src/a.ts', contentKey: 'b'.repeat(64), viewDigest: 'c'.repeat(64), lanes: ['sec-lane'] }],
  lanes: ['sec-lane'],
};

describe('worker verdict cache base client', () => {
  it('derives its endpoint from the completion endpoint only', () => {
    expect(verdictCacheBaseEndpointFor('https://svc.example/api/dispatch/completion'))
      .toBe('https://svc.example/api/dispatch/verdict-cache-base');
    expect(() => verdictCacheBaseEndpointFor('https://svc.example/api/dispatch/other')).toThrow();
    expect(() => verdictCacheBaseEndpointFor('http://svc.example/api/dispatch/completion')).toThrow();
  });

  it('posts its run identity with its bearer and returns the validated source', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ version: 'VerdictCacheBase.v1', runId: RUN, maxAgeMs: 3_600_000, source: planningSource }));
    const client = new HttpVerdictCacheBaseSource({ token: TOKEN, completionEndpoint: 'https://svc.example/api/dispatch/completion',
      runId: RUN, executionAttempt: 1, fetchImplementation: fetcher });
    expect(await client.read()).toEqual({ source: planningSource, maxAgeMs: 3_600_000 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://svc.example/api/dispatch/verdict-cache-base');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init!.body))).toEqual({ version: 'VerdictCacheBaseRequest.v1', runId: RUN, executionAttempt: 1 });
    expect(init!.redirect).toBe('error');
  });

  it('rejects another run\'s answer, a malformed source, a non-200 and an oversized body', async () => {
    const make = (response: () => Response) => new HttpVerdictCacheBaseSource({ token: TOKEN,
      completionEndpoint: 'https://svc.example/api/dispatch/completion', runId: RUN, executionAttempt: 1,
      fetchImplementation: vi.fn<typeof fetch>(async () => response()) });
    await expect(make(() => json({ version: 'VerdictCacheBase.v1', runId: SOURCE_RUN, maxAgeMs: 1, source: null })).read()).rejects.toThrow();
    await expect(make(() => json({ version: 'VerdictCacheBase.v1', runId: RUN, maxAgeMs: 1,
      source: { ...planningSource, extra: true } })).read()).rejects.toThrow();
    await expect(make(() => json({ error: 'no' }, 503)).read()).rejects.toThrow();
    await expect(make(() => new Response('x'.repeat(2_000_001), { status: 200 })).read()).rejects.toThrow();
  });

  it('is built only when the flag is on for the repository, and fail-soft', () => {
    const env = { REVIEW_COMPLETION_URL: 'https://svc.example/api/dispatch/completion', REVIEW_AUTHORITATIVE_GATE: 'true',
      REVIEW_REPO: 'example/candidate', REVIEW_RUN_ID: RUN, REVIEW_EXECUTION_ATTEMPT: '1' };
    expect(publishingWorkerAdapters(env, TOKEN)).not.toHaveProperty('verdictCacheBase');
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_VERDICT_CACHE: 'example/candidate' }, TOKEN).verdictCacheBase)
      .toBeInstanceOf(HttpVerdictCacheBaseSource);
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_VERDICT_CACHE: 'example/other' }, TOKEN)).not.toHaveProperty('verdictCacheBase');
    expect(publishingWorkerAdapters({ ...env, REVIEW_YETI_VERDICT_CACHE: 'all', REVIEW_RUN_ID: 'bad' }, TOKEN)).not.toHaveProperty('verdictCacheBase');
  });
});

describe('dispatch verdict-cache-base route', () => {
  function app(read: ReturnType<typeof vi.fn>) {
    const server = express();
    server.use(express.json());
    server.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn() } as never, admission: { admit: vi.fn() } as never, resolveInstallationId: vi.fn(),
      verdictCacheBase: { read } as never,
    }));
    return server;
  }
  const body = { version: 'VerdictCacheBaseRequest.v1', runId: RUN, executionAttempt: 1 };

  it('answers the authenticated execution with the service source', async () => {
    const read = vi.fn(async () => ({ status: 'ok', source: planningSource, maxAgeMs: 3_600_000 }));
    const response = await request(app(read)).post('/api/dispatch/verdict-cache-base').set('Authorization', `Bearer ${TOKEN}`).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 'VerdictCacheBase.v1', runId: RUN, maxAgeMs: 3_600_000, source: planningSource });
    expect(read).toHaveBeenCalledWith({ runId: RUN, executionAttempt: 1, workerTokenDigest: sha256(TOKEN) });
  });

  it('refuses a missing bearer, a malformed request, another execution and a store failure', async () => {
    const read = vi.fn(async () => ({ status: 'unauthorized' }));
    expect((await request(app(read)).post('/api/dispatch/verdict-cache-base').send(body)).status).toBe(401);
    expect((await request(app(read)).post('/api/dispatch/verdict-cache-base').set('Authorization', `Bearer ${TOKEN}`)
      .send({ ...body, extra: 1 })).status).toBe(400);
    expect((await request(app(read)).post('/api/dispatch/verdict-cache-base').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(403);
    const failing = vi.fn(async () => { throw new Error('db down'); });
    expect((await request(app(failing)).post('/api/dispatch/verdict-cache-base').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(503);
  });

  it('is not mounted without a lookup', async () => {
    const server = express();
    server.use(express.json());
    server.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn() } as never, admission: { admit: vi.fn() } as never, resolveInstallationId: vi.fn(),
    }));
    expect((await request(server).post('/api/dispatch/verdict-cache-base').set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(404);
  });
});
